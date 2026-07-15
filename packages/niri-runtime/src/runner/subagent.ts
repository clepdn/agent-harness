/**
 * Subagent mini-loop — a simplified, synchronous agent loop for spawned
 * subagents. No event waiting, no compaction, no fallback, no memory recall.
 * Just: stream → process tools → repeat → return final text.
 */

import { stream } from "../llm"
import type { AssistantMessage, ToolCall, Context, Model } from "../llm"
import type { OpenAICompletionsOptions } from "../llm"
import { config, type SubagentConfig } from "../config"
import { logMessage } from "../db"
import { emit } from "../stream"
import type { Message } from "../types"
import { executeToolCall } from "./loop-tool-runtime"
import { buildToolHandlers } from "./loop-tool-registry"
import { assistantContentText, isFunctionToolCall } from "./loop-content"
import { getSubagentTools } from "./tools"
import { buildModel, primaryModel, fallbackModel, USE_FALLBACK, PRIMARY_API_KEY, FALLBACK_API_KEY, MODEL_PROVIDER, MODEL_BASE_URL, ENABLE_THINKING, THINKING_EFFORT, PRIMARY_TOOL_CHOICE, FALLBACK_TOOL_CHOICE } from "./config"
import type { LoopHooks, LoopState } from "./types"
import type { FunctionToolCall, ToolHandler } from "./loop-shared"

/** Stub hooks for subagent — no event handling. */
const SUBAGENT_HOOKS: LoopHooks = {
  waitForEvent: () => {
    throw new Error("subagent cannot wait for events")
  },
  waitForEventWithTimeout: () => {
    throw new Error("subagent cannot wait for events")
  },
  injectIncomingEvent: () => {},
  flushDeferredEvents: () => {},
  clearSession: async () => {},
  saveSession: async () => {},
  saveShutdownSnapshot: async () => {},
  shouldShutdown: () => false,
  resolveShutdown: () => {},
}

/** Resolve the model for a subagent, falling back to the primary/fallback. */
function resolveSubagentModel(subagent: SubagentConfig): { model: Model; apiKey: string | undefined; toolChoice: string } {
  if (USE_FALLBACK) {
    return { model: fallbackModel, apiKey: FALLBACK_API_KEY, toolChoice: FALLBACK_TOOL_CHOICE }
  }

  if (subagent.model) {
    const built = buildModel(MODEL_PROVIDER, subagent.model, MODEL_BASE_URL || undefined)
    if (built) {
      return { model: built, apiKey: PRIMARY_API_KEY, toolChoice: PRIMARY_TOOL_CHOICE }
    }
  }

  if (primaryModel) {
    return { model: primaryModel, apiKey: PRIMARY_API_KEY, toolChoice: PRIMARY_TOOL_CHOICE }
  }

  return { model: fallbackModel, apiKey: FALLBACK_API_KEY, toolChoice: FALLBACK_TOOL_CHOICE }
}

/** Find a subagent config by name. Returns undefined if not found. */
export function findSubagent(name: string): SubagentConfig | undefined {
  return config.subagents.find((sa) => sa.name === name)
}

/** List all configured subagent names. */
export function listSubagentNames(): string[] {
  return config.subagents.map((sa) => sa.name)
}

/**
 * Runs a subagent to completion and returns its final text output.
 *
 * The subagent gets a fresh conversation with just its system prompt and the
 * task. It runs a simple loop: stream → process tool calls → repeat, until
 * it produces a turn with no tool calls or hits max_turns.
 */
export async function runSubagent(
  convId: number,
  subagent: SubagentConfig,
  task: string,
): Promise<string> {
  const { model, apiKey, toolChoice } = resolveSubagentModel(subagent)
  const tools = getSubagentTools(subagent.enabled_tools, subagent.blacklisted_tools)

  // Build the system prompt
  const systemPrompt = subagent.system_prompt
    ? `${subagent.system_prompt}\n\nYou are a subagent spawned by the main agent. You have ${subagent.max_turns} turns. Focus on your task and return your result when done. You do not have access to Discord or event-loop tools.`
    : `You are a subagent spawned by the main agent. You have ${subagent.max_turns} turns. Focus on your task and return your result when done. You do not have access to Discord or event-loop tools.`

  // Fresh conversation state
  const state: LoopState = {
    systemPrompt,
    conversation: [
      { role: "user", content: task, timestamp: Date.now() } as Message,
    ],
    pendingInputs: [],
    tokenCount: 0,
    contextSize: 0,
    toolInFlight: false,
    memoryRecallCooldowns: {},
    memoryRecallTurn: 0,
    memoryRecallPending: false,
    shutdownRequested: false,
    turnInFlight: false,
  }

  const allHandlers = buildToolHandlers()
  // Filter handlers to only include tools available to this subagent
  const handlerNames = new Set(tools.map((t) => t.name))
  const handlers: Record<string, ToolHandler> = {}
  for (const [name, handler] of Object.entries(allHandlers)) {
    if (handlerNames.has(name)) {
      handlers[name] = handler
    }
  }

  console.log(`[subagent] spawning "${subagent.name}" (model=${model.id}, tools=${tools.map((t) => t.name).join(",")}, max_turns=${subagent.max_turns})`)

  let turnCount = 0
  let lastText = ""

  while (turnCount < subagent.max_turns) {
    turnCount++

    // Build context for this turn
    const context: Context = {
      systemPrompt: state.systemPrompt || undefined,
      messages: state.conversation,
      tools,
    }

    const resolvedToolChoice = ENABLE_THINKING && toolChoice === "required" ? "auto" : toolChoice
    const options: OpenAICompletionsOptions = {
      ...(apiKey ? { apiKey } : {}),
      toolChoice: resolvedToolChoice as "required" | "auto" | "none",
      ...(ENABLE_THINKING ? { reasoningEffort: THINKING_EFFORT } : {}),
    }

    // Stream the completion
    const eventStream = stream(model, context, options)
    let errorMessage: string | undefined

    for await (const event of eventStream as AsyncIterable<{ type: string; delta?: string; error?: { errorMessage?: string } }>) {
      if (event.type === "text_delta" && event.delta) {
        emit({ type: "text", text: `[subagent:${subagent.name}] ${event.delta}` })
      } else if (event.type === "error") {
        errorMessage = event.error?.errorMessage ?? "unknown API error"
      }
    }

    const finalMessage = await (eventStream as { result(): Promise<AssistantMessage> }).result()

    if (finalMessage.stopReason === "error" || errorMessage) {
      const errMsg = errorMessage ?? finalMessage.errorMessage ?? "unknown API error"
      console.error(`[subagent] "${subagent.name}" stream error: ${errMsg}`)
      return `error: subagent "${subagent.name}" failed: ${errMsg}`
    }

    // Add assistant message to subagent conversation
    state.conversation.push(finalMessage)
    const text = assistantContentText(finalMessage.content)
    if (text) lastText = text
    logMessage(convId, "assistant", `[subagent:${subagent.name}] ${text}`)

    // Extract tool calls
    const toolCalls = finalMessage.content.filter(isFunctionToolCall) as ToolCall[]

    if (toolCalls.length === 0) {
      // No tool calls — subagent is done
      console.log(`[subagent] "${subagent.name}" completed after ${turnCount} turns`)
      return lastText || "(subagent produced no output)"
    }

    // Process tool calls
    for (const call of toolCalls) {
      const outcome = await executeToolCall(
        convId,
        state,
        SUBAGENT_HOOKS,
        handlers,
        call as FunctionToolCall,
      )

      if (outcome.shouldRest) {
        // Shouldn't happen (rest is auto-blacklisted), but handle gracefully
        console.warn(`[subagent] "${subagent.name}" tried to rest; ignoring`)
      }
      // isWait is also auto-blacklisted, but handle gracefully
      if (outcome.isWait) {
        console.warn(`[subagent] "${subagent.name}" tried to wait; ignoring`)
      }
    }
  }

  // Hit max_turns
  console.warn(`[subagent] "${subagent.name}" hit max_turns (${subagent.max_turns})`)
  return lastText || `(subagent "${subagent.name}" hit max_turns without producing output)`
}
