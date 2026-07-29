import { config } from "../config"
import { recordMetric } from "../metrics"
import { emit } from "../stream"
import { setContextSize, setWorking } from "../discord/status-updater"
import { setPromWorking } from "../prometheus"
import type { Message } from "../types"
import { modelState } from "./model-state"
import {
  COMPACTION_MIN_CHARS,
  COMPACTION_TURN_AGE,
  CONTEXT_COMPACT_TRIGGER_TOKENS,
  estimatePromptTokens,
  findSummaryMessageIndex,
  loadAgentSummaryContext,
  proactiveCompaction,
  saveRestSnapshot,
  summarizeConversationViaLLM,
} from "./util"
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

async function waitForNextEvent(convId: number, hooks: LoopHooks): Promise<void> {
  const incoming = await hooks.waitForEvent()
  if (!incoming) return
  hooks.injectIncomingEvent(convId, incoming)
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
  const response = await fetchCompletion(state)
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
 * Proactively summarizes old, large tool results using the compaction model.
 * Only runs when respect_cache is false. Targets tool results that are
 * ≥ compaction_turn_age turns old and ≥ compaction_min_chars in size.
 */
async function applyProactiveCompaction(state: LoopState): Promise<boolean> {
  if (modelState.respectCache) return false

  const provider = configuredSummaryProvider()
  if (!provider.model) return false

  const { messages, compacted } = await proactiveCompaction(
    state.conversation,
    provider.model,
    provider.apiKey,
    COMPACTION_TURN_AGE,
    COMPACTION_MIN_CHARS,
  )

  if (compacted === 0) return false

  const beforeEstimate = state.contextSize
  state.conversation = messages
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

async function applyLLMCompaction(state: LoopState, phase: "pre-turn" | "post-turn"): Promise<boolean> {
  // Gate strictly on the model-reported prompt_tokens (state.contextSize).
  // The char-based estimatePromptTokens inflates the tools schema ~3×, which
  // used to fire compaction at ~22-31k real tokens and produce nonsense summaries.
  if (state.contextSize < CONTEXT_COMPACT_TRIGGER_TOKENS) return false
  const beforeEstimate = estimatePromptTokens(state.conversation)

  const summaryProvider = configuredSummaryProvider()
  if (!summaryProvider.model) {
    console.warn(`[context] ${phase}: no summary model available; skipping llm compaction`)
    return false
  }

  const beforeCount = state.conversation.length
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

  state.conversation = summarized
  state.contextSize = afterEstimate

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

    await applyProactiveCompaction(state)
    await applyLLMCompaction(state, "pre-turn")

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
      await waitForNextEvent(convId, hooks)
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

    await applyLLMCompaction(state, "post-turn")
  }
}

export const __loopTest = {
  applyLoopGuardNudge,
  applyDiscordSendNudge,
  hasDiscordInputForTurn,
  waitForNextEvent,
}
