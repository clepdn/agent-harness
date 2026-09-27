/**
 * Subagent mini-loop — a simplified, synchronous agent loop for spawned
 * subagents. No event waiting, no compaction, no fallback, no memory recall.
 * Just: stream → process tools → repeat → return final text.
 */

import { Context } from "../llm"
import type { ToolCall, Model } from "../llm"
import { config, getModelPreset, type SubagentConfig } from "../config"
import { logMessage } from "../db"
import { emit } from "../stream"
import type { Message } from "../types"
import { executeToolCall } from "./loop-tool-runtime"
import { buildToolHandlers } from "./loop-tool-registry"
import { assistantContentText, isFunctionToolCall } from "./loop-content"
import { getSubagentTools } from "./tools"
import { buildModel, MODEL_PROVIDER, MODEL_BASE_URL } from "./config"
import { modelState } from "./model-state"
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
  refreshToolCatalog: () => {},
  clearSession: async () => {},
  saveSession: async () => {},
  saveShutdownSnapshot: async () => {},
  shouldShutdown: () => false,
  resolveShutdown: () => {},
}

/** Resolve the model for a subagent, falling back to the primary/fallback. */
function resolveSubagentModel(subagent: SubagentConfig): { model: Model; apiKey: string | undefined; toolChoice: string } {
  if (modelState.useFallback) {
    return { model: modelState.fallbackModel, apiKey: modelState.fallbackApiKey, toolChoice: modelState.fallbackToolChoice }
  }

  if (subagent.model) {
    // Treat subagent.model as a preset key and resolve it the same way
    // evaluateModelSwap does — extract provider/model/base_url/api_key from
    // the [models.<name>] table rather than passing it as a raw model ID.
    const preset = getModelPreset(subagent.model)
    if (preset) {
      const provider = typeof preset.provider === "string" ? preset.provider.trim() : MODEL_PROVIDER
      const modelId = typeof preset.model === "string" ? preset.model.trim() : ""
      const baseUrl = typeof preset.base_url === "string" ? preset.base_url.trim() : MODEL_BASE_URL || undefined
      const apiKey = typeof preset.api_key === "string" ? preset.api_key.trim() : undefined
      const contextWindow = typeof preset.context_window === "number" ? preset.context_window : undefined
      if (modelId) {
        const built = buildModel(provider, modelId, baseUrl || undefined, undefined, contextWindow)
        if (built) {
          return { model: built, apiKey: apiKey ?? modelState.primaryApiKey, toolChoice: modelState.primaryToolChoice }
        }
      }
    }
    // Fallback: treat subagent.model as a raw model string (legacy behavior)
    const built = buildModel(MODEL_PROVIDER, subagent.model, MODEL_BASE_URL || undefined)
    if (built) {
      return { model: built, apiKey: modelState.primaryApiKey, toolChoice: modelState.primaryToolChoice }
    }
  }

  if (modelState.primaryModel) {
    return { model: modelState.primaryModel, apiKey: modelState.primaryApiKey, toolChoice: modelState.primaryToolChoice }
  }

  return { model: modelState.fallbackModel, apiKey: modelState.fallbackApiKey, toolChoice: modelState.fallbackToolChoice }
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
  signal?: AbortSignal,
): Promise<string> {
  const { model, apiKey, toolChoice } = resolveSubagentModel(subagent)
  const tools = getSubagentTools(subagent.enabled_tools, subagent.blacklisted_tools)

  // Build the system prompt
  const systemPrompt = subagent.system_prompt
    ? `${subagent.system_prompt}\n\nYou are a subagent spawned by the main agent. You have ${subagent.max_turns} turns. Focus on your task and return your result when done. You do not have access to Discord or event-loop tools.`
    : `You are a subagent spawned by the main agent. You have ${subagent.max_turns} turns. Focus on your task and return your result when done. You do not have access to Discord or event-loop tools.`

  // Fresh conversation state
  const state: LoopState = {
    pendingInputs: [],
    context: new Context({
      model,
      systemPrompt,
      tools,
      apiKey,
      toolChoice: (modelState.enableThinking && toolChoice === "required" ? "auto" : toolChoice) as "required" | "auto" | "none",
      thinkingLevel: modelState.enableThinking ? modelState.thinkingEffort : undefined,
      includeContextImages: modelState.primaryVision,
      items: [{ role: "user", content: task, timestamp: Date.now() } as Message],
    }),
    tokenCount: 0,
    contextSize: 0,
    toolCatalog: [],
    toolCatalogEpoch: 1,
    toolCatalogFingerprint: "",
    toolInFlight: false,
    memoryRecallCooldowns: {},
    memoryRecallTurn: 0,
    memoryRecallPending: false,
    shutdownRequested: false,
    turnInFlight: false,
    operationSignal: signal,
    restRequested: false,
    restReason: "",
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

    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("subagent interrupted")

    let errorMessage: string | undefined
    let finalMessage
    try {
      finalMessage = await state.context.complete({
        ...(signal ? { signal } : {}),
        onEvent: (event) => {
          if (event.type === "text_delta" && event.delta) {
            emit({ type: "text", text: `[subagent:${subagent.name}] ${event.delta}` })
          } else if (event.type === "error") {
            errorMessage = event.error.errorMessage ?? "unknown API error"
          }
        },
      })
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`[subagent] "${subagent.name}" stream error: ${errorMessage}`)
      return `error: subagent "${subagent.name}" failed: ${errorMessage}`
    }

    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("subagent interrupted")

    if (finalMessage.stopReason === "error" || errorMessage) {
      const errMsg = errorMessage ?? finalMessage.errorMessage ?? "unknown API error"
      console.error(`[subagent] "${subagent.name}" stream error: ${errMsg}`)
      return `error: subagent "${subagent.name}" failed: ${errMsg}`
    }

    const text = assistantContentText(finalMessage.content)
    if (text) lastText = text
    const toolCalls = finalMessage.content.filter(isFunctionToolCall) as ToolCall[]
    logMessage(
      convId,
      "assistant",
      `[subagent:${subagent.name}] ${text}`,
      toolCalls.length > 0 ? toolCalls : undefined,
    )

    if (toolCalls.length === 0) {
      // No tool calls — subagent is done
      console.log(`[subagent] "${subagent.name}" completed after ${turnCount} turns`)
      return lastText || "(subagent produced no output)"
    }

    // Process tool calls
    for (const call of toolCalls) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("subagent interrupted")
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
