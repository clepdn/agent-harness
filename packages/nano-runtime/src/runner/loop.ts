import { createHash } from "node:crypto"
import { config } from "../config"
import { recordMetric } from "../metrics"
import { emit } from "../stream"
import { setContextSize, setWorking } from "../discord/status-updater"
import { dispatchDiscordTyping, stopDiscordTyping } from "../discord/typing-lease"
import { recordLlmRequest, setPromWorking } from "../prometheus"
import { cacheRefreshIntervalMs, cacheWarmingCompactionAt, createCacheWarmer } from "./cache-warmer"
import type { Message } from "../types"
import { modelStateFor } from "./model-state"
import {
  TOOL_RESULT_COMPACTION_MIN_CHARS,
  TOOL_RESULT_COMPACTION_MIN_AGE_TURNS,
  TOOL_RESULT_COMPACTION_MIN_CONTEXT_PERCENT,
  meetsToolResultCompactionContextThreshold,
  estimatePromptTokens,
  findSummaryMessageIndex,
  loadAgentSummaryContext,
  proactiveCompaction,
  saveRestSnapshot,
  summarizeConversationViaLLM,
} from "./util"
import type { CompactionStrategy } from "../config"
import {
  journalCompactionSummary,
  resolveDeepArchiveBackend,
} from "./compaction-companion"
import { messageStringContent } from "./messages"
import { addAssistantMessage, applyUsage, configuredSummaryProvider, emitThinking, fetchCompletion } from "./loop-completion"
import { assistantContentText, isFunctionToolCall } from "./loop-content"
import type { AssistantMessage, TextContent, ToolCall } from "../llm"
import { buildTurnSignature, hasIncomingUserMessage } from "./loop-signatures"
import type { CompactionResult, LoopHooks, LoopState, ManualCompactionRequest } from "./types"
import { processToolCalls } from "./loop-tools"

const LLM_RECENT_MIN_KEEP = 6
const LLM_RECENT_MAX_KEEP = 40
const LLM_TAIL_CHAR_BUDGET = 60_000
const RUNNER_MAX_TURNS = Math.max(1, config.runner.max_turns)
const RUNNER_MAX_IDENTICAL_TOOL_TURNS = Math.max(1, config.runner.max_identical_tool_turns)

enum CycleOutcome {
  NoTools = "no_tools",
  ToolsDone = "tools_done",
  Wait = "wait",
  Rest = "rest",
}

export type RunLoopExit = "rest" | "discard"

async function waitForNextEvent(
  convId: number,
  state: LoopState,
  hooks: LoopHooks,
  compact: (state: LoopState, request?: ManualCompactionRequest) => Promise<CompactionResult> =
    (currentState, request) => request
      ? applyManualCompaction(currentState, request)
      : applyCompaction(currentState, "idle"),
): Promise<void> {
  let previousCacheDeadline: number | undefined
  let cacheCompactionRetryAt = 0
  // Wait with the idle timeout when enabled. Each time the timeout fires with no
  // event, compact the idle conversation (summarize the middle so a long-lived
  // session doesn't sit at full context forever) and keep waiting. Any real
  // event — or a rest/shutdown request — breaks out immediately. Even when the
  // timer is disabled, an interrupted plain wait can carry a manual /compact.
  while (true) {
    if (state.restRequested || hooks.shouldShutdown()) return

    // A /compact can be queued while a model or tool call is still in flight.
    // In that case interruptEventWaiters() has nothing to interrupt, so consume
    // the request before subscribing here. Otherwise a following `wait` tool
    // can miss the wakeup and leave the runner asleep with compaction pending.
    if (state.compactionRequest) {
      const request = state.compactionRequest
      state.compactionRequest = undefined
      const compacted = await compact(state, request)
      if (compacted === "rewritten") {
        hooks.refreshToolCatalog("post-compaction")
        console.log("[runner] manual /compact rewrote context at the idle boundary; reactivating immediately")
        return
      }
      if (compacted === "suppressed") console.log("[runner] idle compaction suppressed after no tool result reduction")
      console.log("[runner] manual /compact requested but nothing to compact (summary not smaller)")
      continue
    }

    // Resolve each time so inherited main-model swaps take effect in both lanes.
    const modelState = modelStateFor(state.runtimeKind)
    const cacheDeadline = modelState.cacheWarming && !modelState.useFallback && modelState.compactionStrategy !== "off"
      ? cacheWarmingCompactionAt(state.context.lastCompletionAt, modelState.cacheLifetimeMs, modelState.cacheWarmingDurationMs)
      : undefined
    if (cacheDeadline !== previousCacheDeadline) {
      previousCacheDeadline = cacheDeadline
      cacheCompactionRetryAt = 0
    }
    const cacheWaitUntil = cacheDeadline !== undefined ? Math.max(cacheDeadline, cacheCompactionRetryAt) : undefined
    // A finite warming budget owns idle compaction timing for this preset.
    const idleCompactionMs = cacheWaitUntil !== undefined
      ? Math.min(2_147_483_647, Math.max(1, cacheWaitUntil - Date.now()))
      : modelState.idleCompactionMs
    const incoming = idleCompactionMs > 0
      ? await hooks.waitForEventWithTimeout(idleCompactionMs)
      : await hooks.waitForEvent()
    if (incoming) {
      hooks.injectIncomingEvent(convId, incoming)
      return
    }
    // Null means the timeout fired or the wait was interrupted for rest/
    // shutdown or a manual compaction request. Bail out on rest/shutdown so
    // the loop can handle it.
    if (state.restRequested || hooks.shouldShutdown()) return

    // A manual request that interrupted this wait is consumed at the top of
    // the next iteration. Keeping that path in one place also closes the race
    // where the request was queued just before this wait was registered.
    if (state.compactionRequest) continue

    // A null from a plain wait without a request is a harmless spurious wake.
    if (idleCompactionMs <= 0) continue
    if (cacheWaitUntil !== undefined && Date.now() < cacheWaitUntil) continue

    const compacted = await compact(state)
    if (cacheDeadline !== undefined) {
      // Failed/suppressed compaction retries after a refresh interval, not a spin.
      cacheCompactionRetryAt = Date.now() + cacheRefreshIntervalMs(modelState.cacheLifetimeMs)
    }
    if (compacted === "rewritten") {
      hooks.refreshToolCatalog("post-compaction")
      console.log("[runner] idle compaction rewrote context while waiting for the next event")
      return
    }
    if (compacted === "suppressed") console.log("[runner] idle compaction suppressed after no tool result reduction")
  }
}

async function applyLoopGuardNudge(state: LoopState, _hooks: LoopHooks, reason: string): Promise<void> {
  const guardMessage =
    `[system] hey, you've been going for a while (${reason}). this is just a heads-up in case you're stuck and need help — most likely you're fine and don't need to do anything different, especially if you're actively doing something, in conversation with people, or things are happening RIGHT NOW. just keep going. resting is only a suggestion for if nothing's actually happening and you're genuinely done; if you do rest, remember to tell your important people first.`
  console.warn(`[runner] ${reason}`)
  state.context.append({
    role: "user",
    content: guardMessage,
    timestamp: Date.now(),
  })
  emit({ type: "text", text: guardMessage })
}

async function processAssistantTurn(convId: number, state: LoopState, hooks: LoopHooks): Promise<CycleOutcome> {
  const modelState = modelStateFor(state.runtimeKind)
  const serializedTools = JSON.stringify(state.toolCatalog)
  const fingerprint = createHash("sha256").update(serializedTools).digest("hex")
  if (state.toolCatalogFingerprint && fingerprint !== state.toolCatalogFingerprint) {
    throw new Error(`tool catalog epoch ${state.toolCatalogEpoch} mutated in place`)
  }
  const response = await fetchCompletion(state, state.toolCatalog, state, state.operationSignal)
  // follow-up iterations that work through the same incoming event.
  state.memoryRecallPending = false
  applyUsage(state, response.usage, {
    elapsedMs: response.elapsedMs,
    tokensPerSecond: response.tokensPerSecond,
  })

  const msg = response.message
  addAssistantMessage(convId, msg)

  if (modelState.enableThinking) {
    if (!response.emittedThinking && response.bufferedThinking) {
      emit({ type: "thinking", text: response.bufferedThinking })
    } else if (!response.emittedThinking) {
      emitThinking(msg)
    }
  }

  const toolCalls = msg.content.filter(isFunctionToolCall) as ToolCall[]
  if (!response.emittedText) {
    const text = msg.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("")
    if (text) emit({ type: "text", text })
  }
  if (toolCalls.length === 0) return CycleOutcome.NoTools

  const toolOutcome = await processToolCalls(convId, state, hooks, toolCalls)
  if (toolOutcome === "rest") return CycleOutcome.Rest
  if (toolOutcome === "wait") return CycleOutcome.Wait
  return CycleOutcome.ToolsDone
}

/**
 * Detects when the assistant responded to a Discord message with
 * conversational text but did not call discord_send. Injects a system
 * nudge so the next turn actually delivers the message.
 */
function isDiscordInputMessage(message: Message): boolean {
  return message.role === "user" && typeof message.content === "string" && /\[discord(?:\/(?:dm|channel)| batch)\]/i.test(message.content)
}

function hasDiscordInputForTurn(
  conversation: readonly Message[],
  turnMessages: readonly Message[],
  turnStart: number,
): boolean {
  if (turnMessages.some(isDiscordInputMessage)) return true

  // After a harness restart, the triggering Discord event is appended before
  // the first post-restart assistant turn. Look backward to the latest
  // assistant boundary and treat intervening user messages as active context.
  for (let i = turnStart - 1; i >= 0; i--) {
    const message = conversation[i]
    if (!message) continue
    if (message.role === "assistant") break
    if (isDiscordInputMessage(message)) return true
  }

  return false
}

function applyDiscordSendNudge(
  state: LoopState,
  turnMessages: readonly Message[],
  turnStart = state.context.items.length,
): boolean {
  // Check if the assistant is responding to active Discord input, including
  // the post-restart case where the triggering user message is already in the
  // conversation before the turn begins.
  const hasDiscordInput = hasDiscordInputForTurn(state.context.items, turnMessages, turnStart)
  if (!hasDiscordInput) return false

  // Check if the assistant called discord_send in this turn
  const hasDiscordSend = turnMessages.some(
    (m) =>
      m.role === "assistant" &&
      (m as AssistantMessage).content.some((c) => c.type === "toolCall" && (c as ToolCall).name === "discord_send"),
  )
  if (hasDiscordSend) return false

  // Also check if a tool result from discord_send exists
  const hasDiscordSendResult = turnMessages.some(
    (m) =>
      m.role === "toolResult" &&
      m.toolName === "discord_send" &&
      m.content.some((c) => c.type === "text" && (c as TextContent).text.includes('"ok":true')),
  )
  if (hasDiscordSendResult) return false

  // Find the assistant's text content in this turn
  const assistantText = turnMessages.find((m) => m.role === "assistant" && assistantContentText((m as AssistantMessage).content).length > 0)
  if (!assistantText) return false

  // The assistant wrote something in response to a Discord message but
  // never actually sent it. Nudge.
  const nudge = `[system] you wrote a response to a Discord message but did not call discord_send. your message was not delivered. call discord_send now or explicitly decide not to reply.`
  console.warn("[runner] discord_send nudge: assistant responded to Discord input without calling discord_send")
  state.context.append({ role: "user", content: nudge, timestamp: Date.now() })
  return true
}

function isVoiceDelegationMessage(message: Message): boolean {
  return message.role === "user" && typeof message.content === "string" && message.content.includes("[voice delegation]")
}

function applyVoiceReplyNudge(state: LoopState, turnMessages: readonly Message[], turnStart = state.context.items.length): boolean {
  let hasDelegation = turnMessages.some(isVoiceDelegationMessage)
  if (!hasDelegation) {
    for (let i = turnStart - 1; i >= 0; i -= 1) {
      const message = state.context.items[i]
      if (!message) continue
      if (message.role === "assistant") break
      if (isVoiceDelegationMessage(message)) { hasDelegation = true; break }
    }
  }
  if (!hasDelegation) return false
  const replied = turnMessages.some((message) =>
    message.role === "assistant" &&
    (message as AssistantMessage).content.some((part) => part.type === "toolCall" && (part as ToolCall).name === "voice_reply")
  )
  if (replied) return false
  state.context.append({
    role: "user",
    content: "[system] this turn is answering a live voice delegation but did not call voice_reply. private text is not spoken. call voice_reply with the pending delegation_id and only the final answer intended for speech.",
    timestamp: Date.now(),
  })
  return true
}

/**
 * Proactively summarizes old, large tool results once enough of the active
 * model's context window is occupied.
 */
async function applyProactiveCompaction(state: LoopState): Promise<CompactionResult> {
  const modelState = modelStateFor(state.runtimeKind)
  if (modelState.respectPromptCache) return "none"

  const activeModel = modelState.useFallback ? modelState.fallbackModel : modelState.primaryModel
  if (
    !activeModel ||
    !meetsToolResultCompactionContextThreshold(
      state.contextSize,
      activeModel.contextWindow,
      TOOL_RESULT_COMPACTION_MIN_CONTEXT_PERCENT,
    )
  ) {
    return "none"
  }

  const provider = configuredSummaryProvider("default", state)
  if (!provider.model) return "none"

  const { messages, compacted, attempted } = await proactiveCompaction(
    state.context.items,
    provider.model,
    provider.apiKey,
    TOOL_RESULT_COMPACTION_MIN_AGE_TURNS,
    TOOL_RESULT_COMPACTION_MIN_CHARS,
  )

  if (attempted === 0) return "none"
  state.context = state.context.fork({ items: messages, reason: "compaction" })
  if (compacted === 0) {
    console.warn("[context] proactive: tool result could not be reduced; suppressing repeat attempts")
    return "suppressed"
  }

  const beforeEstimate = state.contextSize
  state.contextSize = estimatePromptTokens(state.context.items)
  setContextSize(state.contextSize)

  console.log(
    `[context] proactive: compacted ${compacted} tool result(s) (${beforeEstimate} -> ${state.contextSize} tokens)`,
  )

  recordMetric({
    type: "compaction",
    before: beforeEstimate,
    after: state.contextSize,
    method: "proactive",
    summary: undefined,
  })

  return "rewritten"
}

/** Pull the summary text out of a compacted conversation, if present. */
function extractSummaryText(messages: readonly Message[]): string | undefined {
  const idx = findSummaryMessageIndex(messages)
  if (idx < 0) return undefined
  const msg = messages[idx]
  const text = msg ? messageStringContent(msg) : ""
  return text.trim() || undefined
}

/**
 * The messages that a compaction dropped: everything in `before` whose exact
 * content no longer survives verbatim in `after`. Used to feed the deep archive
 * the specifics the summary compressed away.
 */
function discardedMessages(before: readonly Message[], after: readonly Message[]): Message[] {
  const kept = new Set(after.map((m) => messageStringContent(m)))
  return before.filter((m) => !kept.has(messageStringContent(m)))
}

/**
 * Top-level compaction dispatcher. Routes the configured strategy to the right
 * pipeline once the trigger threshold is crossed. Runs on every loop iteration;
 * cheap no-op below threshold.
 */

async function applyCompaction(state: LoopState, phase: "pre-turn" | "post-turn" | "idle"): Promise<CompactionResult> {
  const modelState = modelStateFor(state.runtimeKind)
  const strategy = modelState.compactionStrategy
  if (strategy === "off") return "none"
  if (phase === "idle") {
    const idleStrategy = strategy === "snapcompact" ? "context-full" : strategy
    return applyLLMCompaction(state, phase, idleStrategy, true)
  }

  if (state.contextSize >= modelState.compactTriggerTokens) {
    // At/over the cliff: run the strategy's full burn.
    if (strategy === "snapcompact") {
      // The bitmap renderer is available now (via deep_archive frames in the
      // companion path), but the *pure* image-only strategy - drop the middle
      // with no LLM summary at all - is a distinct pipeline that isn't wired
      // yet, so degrade to context-full rather than silently skipping the burn.
      // To get real frames today, use compaction_strategy="companion" with
      // deep_archive=true on a vision model.
      console.warn("[context] standalone snapcompact strategy not wired yet; using context-full (companion+deep_archive gives frames)")
      return applyLLMCompaction(state, phase, "context-full")
    }
    return applyLLMCompaction(state, phase, strategy)
  }

  // Below the cliff: keep tool-result spam in check (except companion, which
  // defers all rewriting to the single cliff-defense burn to protect cache).
  if (strategy === "companion") return "none"
  return applyProactiveCompaction(state)
}

async function applyLLMCompaction(
  state: LoopState,
  phase: "pre-turn" | "post-turn" | "idle" | "shutdown",
  strategy?: CompactionStrategy,
  force = false,
  options: {
    forceSummaryModel?: boolean
    forceSnapcompact?: boolean
  } = {},
): Promise<CompactionResult> {
  const modelState = modelStateFor(state.runtimeKind)
  const resolvedStrategy = strategy ?? modelState.compactionStrategy
  // Gate strictly on the model-reported prompt_tokens (state.contextSize).
  // The char-based estimatePromptTokens inflates the tools schema ~3×, which
  // used to fire compaction at ~22-31k real tokens and produce nonsense summaries.
  // `force` bypasses the gate — used on a clean end_session so the goodbye
  // leaves a real summary behind even below the trigger.
  if (!force && state.contextSize < modelState.compactTriggerTokens) return "none"
  const beforeEstimate = estimatePromptTokens(state.context.items)

  // companion + context-full salvage lessons from the same head that generated
  // the conversation (private-reasoning models hide their CoT otherwise), and
  // accept a one-time cache bust at the cliff. "remote" also summarizes locally
  // here when no provider endpoint is wired (the endpoint path is future work).
  const preferActiveModel = resolvedStrategy === "companion" || resolvedStrategy === "context-full" || resolvedStrategy === "remote"
  const providerPreference = options.forceSummaryModel
    ? "configured"
    : preferActiveModel ? "active" : "default"
  const summaryProvider = configuredSummaryProvider(providerPreference, state)
  if (!summaryProvider.model) {
    console.warn(`[context] ${phase}: no summary model available; skipping llm compaction`)
    return "none"
  }

  const beforeCount = state.context.items.length
  const beforeMessages = state.context.items
  const agentContext = await loadAgentSummaryContext(state.runtimeKind)
  const summarized = await summarizeConversationViaLLM(
    state.context.items,
    summaryProvider.model,
    summaryProvider.apiKey,
    {
      recentMinKeep: LLM_RECENT_MIN_KEEP,
      recentMaxKeep: LLM_RECENT_MAX_KEEP,
      tailCharBudget: LLM_TAIL_CHAR_BUDGET,
      agentContext,
      primaryHandoff: options.forceSummaryModel === true,
    },
  )
  if (!summarized) {
    console.warn(`[context] ${phase}: llm summary unavailable; keeping raw conversation`)
    return "none"
  }

  const afterEstimate = estimatePromptTokens(summarized)
  if (afterEstimate >= beforeEstimate) {
    console.warn(`[context] ${phase}: llm summary not smaller (${beforeEstimate} -> ${afterEstimate}); keeping raw conversation`)
    return "none"
  }

  // Companion layers 1 + 3 wrap the summary that summarize.ts produced.
  if (resolvedStrategy === "companion") {
    const summaryText = extractSummaryText(summarized)
    // Layer 1 — journal-first: mirror the summary into durable memory before
    // the raw middle is dropped. Best-effort; never blocks the burn.
    // Same-model compaction can safely journal its own recollection. A small
    // summarizer instead hands its play-by-play to the primary model and asks
    // that model to journal it on the immediately following turn.
    if (summaryText && !options.forceSummaryModel) await journalCompactionSummary(summaryText)

    // Layer 3 — deep archive: preserve the specifics the summary compressed.
    const discarded = discardedMessages(beforeMessages, summarized)
    const activeModel = modelState.useFallback ? modelState.fallbackModel : modelState.primaryModel
    const backend = resolveDeepArchiveBackend(activeModel?.provider, options.forceSnapcompact, modelState)
    const archived = await backend.archive(discarded).catch((err) => {
      console.warn(`[context] deep archive (${backend.name}) failed: ${(err as Error)?.message ?? err}`)
      return null
    })
    if (archived?.archiveMessage) {
      // Insert the appendix right after the summary message so it reads as a
      // reference block attached to the compacted history.
      const idx = findSummaryMessageIndex(summarized)
      if (idx >= 0) summarized.splice(idx + 1, 0, archived.archiveMessage)
      else summarized.unshift(archived.archiveMessage)
    }
    if (archived) console.log(`[context] deep archive: ${archived.note}`)
  }

  state.context = state.context.fork({ items: summarized, reason: "compaction" })
  state.contextSize = estimatePromptTokens(summarized)

  const summaryIdx = findSummaryMessageIndex(state.context.items)
  const summaryMsg = summaryIdx >= 0 ? state.context.items[summaryIdx] : undefined
  const summary = summaryMsg?.role === "user" && typeof summaryMsg.content === "string" ? summaryMsg.content : undefined

  console.log(
    `[context] ${phase}: llm-summarized conversation via ${summaryProvider.model} (${beforeCount} -> ${summarized.length} msgs, ${beforeEstimate} -> ${afterEstimate} tokens)`,
  )

  recordMetric({
    type: "compaction",
    before: beforeEstimate,
    after: afterEstimate,
    method: `${phase}-llm`,
    summary,
  })
  return "rewritten"
}

/** Run one operator-requested burn, independent of trigger and strategy=off. */
async function applyManualCompaction(
  state: LoopState,
  request: ManualCompactionRequest,
): Promise<CompactionResult> {
  const modelState = modelStateFor(state.runtimeKind)
  const configured = modelState.compactionStrategy
  const strategy: CompactionStrategy = request.snapcompact || configured === "off" || configured === "snapcompact"
    ? "companion"
    : configured
  return applyLLMCompaction(state, "idle", strategy, true, {
    forceSummaryModel: request.forceSummaryModel,
    forceSnapcompact: request.snapcompact,
  })
}

/**
 * Force a compaction pass regardless of the token trigger, for a clean
 * end_session. Summarizes the middle so the goodbye leaves a real
 * `[context summary v1]` behind for the next boot to rehydrate from, instead of
 * resting with "(no llm context summary yet)". No-op if there's nothing worth
 * compacting (the summary wouldn't be smaller) or no summary model is available.
 * Returns true if a summary was produced.
 */
export async function compactForShutdown(state: LoopState): Promise<CompactionResult> {
  const modelState = modelStateFor(state.runtimeKind)
  const strategy = modelState.compactionStrategy === "off" ? "companion" : modelState.compactionStrategy
  if (strategy === "snapcompact") return applyLLMCompaction(state, "shutdown", "context-full", true)
  return applyLLMCompaction(state, "shutdown", strategy, true)
}
function pendingDiscordChannel(conversation: readonly Message[], endExclusive: number): string | undefined {
  for (let index = endExclusive - 1; index >= 0; index -= 1) {
    const message = conversation[index]
    if (!message) continue
    if (message.role === "assistant") break
    if (message.role !== "user" || typeof message.content !== "string") continue
    if (!/\[discord(?:\/(?:dm|channel)| batch)\]/i.test(message.content)) continue
    const dmMatch = message.content.match(/context:\s*DM\s+(\S+)/i)
    const channelMatch = message.content.match(/context:\s*[^\n]+\(([^)]+)\)/i)
    return dmMatch?.[1] ?? channelMatch?.[1]
  }
  return undefined
}

function clearDiscordTypingScope(state: LoopState): void {
  stopDiscordTyping(state.discordTypingTurnId)
  state.discordTypingTurnId = undefined
  state.discordTypingChannelId = undefined
}

export async function runLoop(convId: number, state: LoopState, hooks: LoopHooks): Promise<RunLoopExit> {
  let turnCount = 0
  let previousTurnSignature: string | null = null
  let consecutiveIdenticalToolTurns = 0
  const cacheWarmer = createCacheWarmer({
    target: () => {
      const modelState = modelStateFor(state.runtimeKind)
      return {
        context: state.context,
        lifetimeMs: modelState.cacheLifetimeMs,
        durationMs: modelState.compactionStrategy === "off" ? 0 : modelState.cacheWarmingDurationMs,
        mode: modelState.cacheWarmingMode,
        enabled: modelState.cacheWarming && !modelState.useFallback &&
          !state.restRequested && !state.discardRequested && !hooks.shouldShutdown() &&
          state.context.model.id === modelState.primaryModel?.id,
        busy: state.turnInFlight || state.toolInFlight,
      }
    },
    onUsage: (target, usage) => {
      const context = target.context
      recordLlmRequest(context.model.id, "success", usage)
      recordMetric({ type: "usage", usage })
      if (state.context === context) state.tokenCount += usage.totalTokens
      console.log(`[cache-warm] ${context.model.id}: input=${usage.input} cache_read=${usage.cacheRead} cache_write=${usage.cacheWrite} output=${usage.output}`)
    },
    onError: (error) => console.warn("[cache-warm] refresh failed; retrying later:", error instanceof Error ? error.message : String(error)),
  })

  try {
  while (true) {
    cacheWarmer.activity()
    hooks.onTurnStart?.()
    if (state.discardRequested) {
      console.log("[runner] session discard requested")
      clearDiscordTypingScope(state)
      setWorking(false)
      setPromWorking(false)
      return "discard"
    }
    // Check for programmatic rest at the top of each iteration.
    // This catches rest requested during event wait (waitForNextEvent returns
    // null, loop continues here) and during tool processing.
    if (state.restRequested) {
      console.log(`[runner] programmatic rest requested: ${state.restReason}`)
      await saveRestSnapshot(state.context.items, state.restReason, state.runtimeKind)
      clearDiscordTypingScope(state)
      setWorking(false)
      setPromWorking(false)
      return "rest"
    }

    const compacted = await applyCompaction(state, "pre-turn")
    if (compacted === "rewritten") hooks.refreshToolCatalog("post-compaction")
    if (state.discardRequested) {
      clearDiscordTypingScope(state)
      setWorking(false)
      setPromWorking(false)
      return "discard"
    }

    const turnStart = state.context.items.length
    const typingTurnId = state.discordTypingTurnId ?? `${convId}:${turnCount + 1}`
    if (!state.discordTypingTurnId) {
      const channel = state.discordTargets?.at(-1)?.channelId ?? pendingDiscordChannel(state.context.items, turnStart)
      if (channel) {
        state.discordTypingTurnId = typingTurnId
        state.discordTypingChannelId = channel
        dispatchDiscordTyping(typingTurnId, channel)
      }
    }

    const turnController = new AbortController()
    state.activeTurnController = turnController
    state.operationSignal = turnController.signal
    state.turnInFlight = true
    setWorking(true)
    setPromWorking(true)
    let outcome: CycleOutcome | undefined
    let interrupted = false
    try {
      outcome = await processAssistantTurn(convId, state, hooks)
    } catch (err) {
      clearDiscordTypingScope(state)
      setWorking(false)
      setPromWorking(false)
      if (state.discardRequested) return "discard"
      if (state.interruptRequested || turnController.signal.aborted) {
        console.log("[runner] active turn interrupted by operator")
        state.interruptRequested = false
        interrupted = true
      } else {
        throw err
      }
    } finally {
      state.turnInFlight = false
      state.operationSignal = undefined
      if (state.activeTurnController === turnController) state.activeTurnController = undefined
    }
    if (interrupted) {
      await waitForNextEvent(convId, state, hooks)
      continue
    }
    if (!outcome) throw new Error("assistant turn completed without an outcome")
    turnCount += 1

    if (state.discardRequested) {
      clearDiscordTypingScope(state)
      setWorking(false)
      setPromWorking(false)
      return "discard"
    }
    if (state.interruptRequested || turnController.signal.aborted) {
      console.log("[runner] active turn interrupted by operator")
      state.interruptRequested = false
      clearDiscordTypingScope(state)
      setWorking(false)
      setPromWorking(false)
      await waitForNextEvent(convId, state, hooks)
      continue
    }

    const turnMessages = state.context.items.slice(turnStart)
    const interruptedByUserEvent = hasIncomingUserMessage(turnMessages)
    const turnSignature = buildTurnSignature(turnMessages)

    // Nudge when the assistant produces conversational text in response to
    // a Discord message but forgets to call discord_send. This is a common
    // hallucination pattern — the model writes a reply "in its head" and
    // then calls wait/rest, leaving the Discord user in silence.
    let deliveryNudged = false
    if (outcome !== CycleOutcome.Rest) {
      deliveryNudged = applyDiscordSendNudge(state, turnMessages, turnStart)
        || applyVoiceReplyNudge(state, turnMessages, turnStart)
    }

    if (interruptedByUserEvent || !turnSignature) {
      previousTurnSignature = null
      consecutiveIdenticalToolTurns = 0
    } else if (turnSignature === previousTurnSignature) {
      consecutiveIdenticalToolTurns += 1
    } else {
      previousTurnSignature = turnSignature
      consecutiveIdenticalToolTurns = 1
    }

    if (outcome === CycleOutcome.Rest) {
      clearDiscordTypingScope(state)
      setWorking(false)
      setPromWorking(false)
      return "rest"
    }

    // Programmatic rest (e.g. model swap that requires fresh context)
    if (state.restRequested) {
      console.log(`[runner] programmatic rest requested: ${state.restReason}`)
      await saveRestSnapshot(state.context.items, state.restReason, state.runtimeKind)
      clearDiscordTypingScope(state)
      setWorking(false)
      setPromWorking(false)
      return "rest"
    }

    if (outcome === CycleOutcome.NoTools) {
      if (deliveryNudged) continue
      if (modelStateFor(state.runtimeKind).primaryNudgeOnNoTool) {
        state.context.append({
          role: "user",
          content: "[system] Your turn would have ended here. If you really want to wait, call one of your wait tools. You'll stay in a tool loop otherwise.",
          timestamp: Date.now(),
        })
        continue
      }
      clearDiscordTypingScope(state)
      setWorking(false)
      setPromWorking(false)
      await waitForNextEvent(convId, state, hooks)
      continue
    }

    if (outcome === CycleOutcome.Wait) {
      if (deliveryNudged) continue
      clearDiscordTypingScope(state)
      setWorking(false)
      setPromWorking(false)
      await waitForNextEvent(convId, state, hooks)
      continue
    }

    if (turnCount >= RUNNER_MAX_TURNS) {
      await applyLoopGuardNudge(state, hooks, `loop guard tripped after ${turnCount} turns`)
      turnCount = 0
      previousTurnSignature = null
      consecutiveIdenticalToolTurns = 0
      continue
    }

    if (consecutiveIdenticalToolTurns >= RUNNER_MAX_IDENTICAL_TOOL_TURNS && previousTurnSignature) {
      await applyLoopGuardNudge(
        state,
        hooks,
        `loop guard tripped after ${consecutiveIdenticalToolTurns} identical assistant/tool turns`,
      )
      previousTurnSignature = null
      consecutiveIdenticalToolTurns = 0
      continue
    }
  }
  } finally {
    cacheWarmer.stop()
    clearDiscordTypingScope(state)
  }
}
export const __loopTest = {
  applyLoopGuardNudge,
  applyDiscordSendNudge,
  applyVoiceReplyNudge,
  hasDiscordInputForTurn,
  waitForNextEvent,
  applyCompaction,
  applyManualCompaction,
  pendingDiscordChannel,
}
