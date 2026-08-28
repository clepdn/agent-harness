import { config } from "../config"
import { recordMetric } from "../metrics"
import { emit } from "../stream"
import { setContextSize, setWorking } from "../discord/status-updater"
import { setPromWorking } from "../prometheus"
import type { Message } from "../types"
import { modelState } from "./model-state"
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
import { processToolCalls } from "./loop-tools"
import type { LoopHooks, LoopState } from "./types"

const LLM_RECENT_MIN_KEEP = 6
const LLM_RECENT_MAX_KEEP = 40
const LLM_TAIL_CHAR_BUDGET = 60_000
const RUNNER_MAX_TURNS = Math.max(1, config.runner.max_turns)
const RUNNER_MAX_IDENTICAL_TOOL_TURNS = Math.max(1, config.runner.max_identical_tool_turns)

enum CycleOutcome {
  NoTools = "no_tools",
  ToolsDone = "tools_done",
  Rest = "rest",
}

export type RunLoopExit = "rest"

async function waitForNextEvent(convId: number, state: LoopState, hooks: LoopHooks): Promise<void> {
  // When idle compaction is disabled, just block until the next event.
  // Read from modelState so it swaps with the model preset at runtime.
  const idleCompactionMs = modelState.idleCompactionMs
  if (idleCompactionMs <= 0) {
    const incoming = await hooks.waitForEvent()
    if (!incoming) return
    hooks.injectIncomingEvent(convId, incoming)
    return
  }

  // Otherwise wait with the idle timeout. Each time the timeout fires with no
  // event, compact the idle conversation (summarize the middle so a long-lived
  // session doesn't sit at full context forever) and keep waiting. Any real
  // event — or a rest/shutdown request — breaks out immediately.
  while (true) {
    const incoming = await hooks.waitForEventWithTimeout(idleCompactionMs)
    if (incoming) {
      hooks.injectIncomingEvent(convId, incoming)
      return
    }
    // Null means the timeout fired or the wait was interrupted for rest/
    // shutdown or a manual compaction request. Bail out on rest/shutdown so
    // the loop can handle it.
    if (state.restRequested || hooks.shouldShutdown()) return

    // A manual /compact request interrupts the wait; run a forced pass and
    // clear the flag so we don't loop on it.
    const manual = state.compactionRequested === true
    if (manual) state.compactionRequested = false

    const compacted = await applyCompaction(state, "idle")
    if (compacted) {
      console.log(
        `[runner] idle compaction ran while waiting for the next event${manual ? " (manual /compact)" : ""}`,
      )
    } else if (manual) {
      console.log("[runner] manual /compact requested but nothing to compact (summary not smaller)")
    }
  }
}

async function applyLoopGuardNudge(state: LoopState, _hooks: LoopHooks, reason: string): Promise<void> {
  const guardMessage =
    `[system] hey, you've been going for a while (${reason}). this is just a heads-up in case you're stuck and need help — most likely you're fine and don't need to do anything different, especially if you're actively doing something, in conversation with people, or things are happening RIGHT NOW. just keep going. resting is only a suggestion for if nothing's actually happening and you're genuinely done; if you do rest, remember to tell your important people first.`
  console.warn(`[runner] ${reason}`)
  state.conversation.push({
    role: "user",
    content: guardMessage,
    timestamp: Date.now(),
  })
  emit({ type: "text", text: guardMessage })
}

async function processAssistantTurn(convId: number, state: LoopState, hooks: LoopHooks): Promise<CycleOutcome> {
  state.memoryRecallTurn += 1
  const response = await fetchCompletion(state, hooks.getTools?.())
  // Recall (if any) has been applied for this turn; don't re-recall on the
  // follow-up iterations that work through the same incoming event.
  state.memoryRecallPending = false
  applyUsage(state, response.usage, {
    elapsedMs: response.elapsedMs,
    tokensPerSecond: response.tokensPerSecond,
  })

  const msg = response.message
  addAssistantMessage(convId, state, msg)

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

  const shouldRest = await processToolCalls(convId, state, hooks, toolCalls)
  return shouldRest ? CycleOutcome.Rest : CycleOutcome.ToolsDone
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
  conversation: Message[],
  turnMessages: Message[],
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
  turnMessages: Message[],
  turnStart = state.conversation.length,
): boolean {
  // Check if the assistant is responding to active Discord input, including
  // the post-restart case where the triggering user message is already in the
  // conversation before the turn begins.
  const hasDiscordInput = hasDiscordInputForTurn(state.conversation, turnMessages, turnStart)
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
  state.conversation.push({ role: "user", content: nudge, timestamp: Date.now() })
  return true
}

/**
 * Proactively summarizes old, large tool results once enough of the active
 * model's context window is occupied.
 */
async function applyProactiveCompaction(state: LoopState): Promise<boolean> {
  if (modelState.respectPromptCache) return false

  const activeModel = modelState.useFallback ? modelState.fallbackModel : modelState.primaryModel
  if (
    !activeModel ||
    !meetsToolResultCompactionContextThreshold(
      state.contextSize,
      activeModel.contextWindow,
      TOOL_RESULT_COMPACTION_MIN_CONTEXT_PERCENT,
    )
  ) {
    return false
  }

  const provider = configuredSummaryProvider()
  if (!provider.model) return false

  const { messages, compacted, attempted } = await proactiveCompaction(
    state.conversation,
    provider.model,
    provider.apiKey,
    TOOL_RESULT_COMPACTION_MIN_AGE_TURNS,
    TOOL_RESULT_COMPACTION_MIN_CHARS,
  )

  if (attempted === 0) return false
  state.conversation = messages
  if (compacted === 0) {
    console.warn("[context] proactive: tool result could not be reduced; suppressing repeat attempts")
    return true
  }

  const beforeEstimate = state.contextSize
  state.contextSize = estimatePromptTokens(state.conversation)
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

  return true
}

/** Pull the summary text out of a compacted conversation, if present. */
function extractSummaryText(messages: Message[]): string | undefined {
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
function discardedMessages(before: Message[], after: Message[]): Message[] {
  const kept = new Set(after.map((m) => messageStringContent(m)))
  return before.filter((m) => !kept.has(messageStringContent(m)))
}

/**
 * Top-level compaction dispatcher. Routes the configured strategy to the right
 * pipeline once the trigger threshold is crossed. Runs on every loop iteration;
 * cheap no-op below threshold.
 */
async function applyCompaction(state: LoopState, phase: "pre-turn" | "post-turn" | "idle"): Promise<boolean> {
  // Read from modelState so strategy + trigger swap with the model preset.
  const strategy = modelState.compactionStrategy
  if (strategy === "off") return false

  // Idle is special: we compact NO MATTER WHAT the token count is, so the next
  // event doesn't pay to prefill a fat raw conversation. Force through the LLM
  // path (same as compactForShutdown). The afterEstimate<beforeEstimate guard
  // inside applyLLMCompaction still protects against a summary that isn't smaller.
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
  if (strategy === "companion") return false
  return applyProactiveCompaction(state)
}

async function applyLLMCompaction(
  state: LoopState,
  phase: "pre-turn" | "post-turn" | "idle" | "shutdown",
  strategy: CompactionStrategy = modelState.compactionStrategy,
  force = false,
): Promise<boolean> {
  // Gate strictly on the model-reported prompt_tokens (state.contextSize).
  // The char-based estimatePromptTokens inflates the tools schema ~3×, which
  // used to fire compaction at ~22-31k real tokens and produce nonsense summaries.
  // `force` bypasses the gate — used on a clean end_session so the goodbye
  // leaves a real summary behind even below the trigger.
  if (!force && state.contextSize < modelState.compactTriggerTokens) return false
  const beforeEstimate = estimatePromptTokens(state.conversation)

  // companion + context-full salvage lessons from the same head that generated
  // the conversation (private-reasoning models hide their CoT otherwise), and
  // accept a one-time cache bust at the cliff. "remote" also summarizes locally
  // here when no provider endpoint is wired (the endpoint path is future work).
  const preferActiveModel = strategy === "companion" || strategy === "context-full" || strategy === "remote"
  const summaryProvider = configuredSummaryProvider(preferActiveModel)
  if (!summaryProvider.model) {
    console.warn(`[context] ${phase}: no summary model available; skipping llm compaction`)
    return false
  }

  const beforeCount = state.conversation.length
  const beforeMessages = state.conversation
  const agentContext = await loadAgentSummaryContext()
  const summarized = await summarizeConversationViaLLM(
    state.conversation,
    summaryProvider.model,
    summaryProvider.apiKey,
    {
      recentMinKeep: LLM_RECENT_MIN_KEEP,
      recentMaxKeep: LLM_RECENT_MAX_KEEP,
      tailCharBudget: LLM_TAIL_CHAR_BUDGET,
      agentContext,
    },
  )
  if (!summarized) {
    console.warn(`[context] ${phase}: llm summary unavailable; keeping raw conversation`)
    return false
  }

  const afterEstimate = estimatePromptTokens(summarized)
  if (afterEstimate >= beforeEstimate) {
    console.warn(`[context] ${phase}: llm summary not smaller (${beforeEstimate} -> ${afterEstimate}); keeping raw conversation`)
    return false
  }

  // Companion layers 1 + 3 wrap the summary that summarize.ts produced.
  if (strategy === "companion") {
    const summaryText = extractSummaryText(summarized)
    // Layer 1 — journal-first: mirror the summary into durable memory before
    // the raw middle is dropped. Best-effort; never blocks the burn.
    if (summaryText) await journalCompactionSummary(summaryText)

    // Layer 3 — deep archive: preserve the specifics the summary compressed.
    const discarded = discardedMessages(beforeMessages, summarized)
    const activeModel = modelState.useFallback ? modelState.fallbackModel : modelState.primaryModel
    const backend = resolveDeepArchiveBackend(activeModel?.provider)
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

  state.conversation = summarized
  state.contextSize = estimatePromptTokens(summarized)

  const summaryIdx = findSummaryMessageIndex(state.conversation)
  const summaryMsg = summaryIdx >= 0 ? state.conversation[summaryIdx] : undefined
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
  return true
}

/**
 * Force a compaction pass regardless of the token trigger, for a clean
 * end_session. Summarizes the middle so the goodbye leaves a real
 * `[context summary v1]` behind for the next boot to rehydrate from, instead of
 * resting with "(no llm context summary yet)". No-op if there's nothing worth
 * compacting (the summary wouldn't be smaller) or no summary model is available.
 * Returns true if a summary was produced.
 */
export async function compactForShutdown(state: LoopState): Promise<boolean> {
  const strategy = modelState.compactionStrategy === "off" ? "companion" : modelState.compactionStrategy
  if (strategy === "snapcompact") {
    return applyLLMCompaction(state, "shutdown", "context-full", true)
  }
  return applyLLMCompaction(state, "shutdown", strategy, true)
}

export async function runLoop(convId: number, state: LoopState, hooks: LoopHooks): Promise<RunLoopExit> {
  let turnCount = 0
  let previousTurnSignature: string | null = null
  let consecutiveIdenticalToolTurns = 0

  while (true) {
    // Check for programmatic rest at the top of each iteration.
    // This catches rest requested during event wait (waitForNextEvent returns
    // null, loop continues here) and during tool processing.
    if (state.restRequested) {
      console.log(`[runner] programmatic rest requested: ${state.restReason}`)
      await saveRestSnapshot(state.conversation, state.restReason)
      setWorking(false)
      setPromWorking(false)
      return "rest"
    }

    await applyCompaction(state, "pre-turn")

    const turnStart = state.conversation.length
    setWorking(true)
    setPromWorking(true)
    const outcome = await processAssistantTurn(convId, state, hooks)
    turnCount += 1

    const turnMessages = state.conversation.slice(turnStart)
    const interruptedByUserEvent = hasIncomingUserMessage(turnMessages)
    const turnSignature = buildTurnSignature(turnMessages)

    // Nudge when the assistant produces conversational text in response to
    // a Discord message but forgets to call discord_send. This is a common
    // hallucination pattern — the model writes a reply "in its head" and
    // then calls wait/rest, leaving the Discord user in silence.
    let discordSendNudged = false
    if (outcome !== CycleOutcome.Rest) {
      discordSendNudged = applyDiscordSendNudge(state, turnMessages, turnStart)
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
      setWorking(false)
      setPromWorking(false)
      return "rest"
    }

    // Programmatic rest (e.g. model swap that requires fresh context)
    if (state.restRequested) {
      console.log(`[runner] programmatic rest requested: ${state.restReason}`)
      await saveRestSnapshot(state.conversation, state.restReason)
      setWorking(false)
      setPromWorking(false)
      return "rest"
    }

    if (outcome === CycleOutcome.NoTools) {
      if (discordSendNudged) continue
      if (modelState.primaryNudgeOnNoTool) {
        state.conversation.push({
          role: "user",
          content: "[system] Your turn would have ended here. If you really want to wait, call one of your wait tools. You'll stay in a tool loop otherwise.",
          timestamp: Date.now(),
        })
        continue
      }
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
}

export const __loopTest = {
  applyLoopGuardNudge,
  applyDiscordSendNudge,
  hasDiscordInputForTurn,
  waitForNextEvent,
  applyCompaction,
}
