import { Context, type Model, type Tool } from "../llm"
import type { ToolCall } from "../llm"
import type { JsonSchema } from "@nano/harness-core"
import { config, getModelPreset, type SubagentConfig } from "../config"
import type { RuntimeModelConfig } from "./model-state"
import type { Message } from "../types"
import { executeToolCall, recordToolResult } from "./loop-tool-runtime"
import { assistantContentText, isFunctionToolCall } from "./loop-content"
import { isToolEnabledForSubagent } from "./tools"
import { buildModel, MODEL_PROVIDER, MODEL_BASE_URL } from "./config"
import type { LoopHooks, LoopState, RuntimeKind } from "./types"
import type { FunctionToolCall } from "./loop-shared"
import type { RuntimeExecutionServices, SubagentService } from "../plugins/api"
/** Stub hooks for subagent — no event handling. */
const SUBAGENT_HOOKS: LoopHooks = {
  waitForEvent: () => { throw new Error("subagent cannot wait for events") },
  waitForEventWithTimeout: () => { throw new Error("subagent cannot wait for events") },
  injectIncomingEvent: () => {},
  flushDeferredEvents: () => {},
  refreshToolCatalog: () => {},
  clearSession: async () => {},
  saveSession: async () => {},
  saveShutdownSnapshot: async () => {},
  shouldShutdown: () => false,
  resolveShutdown: () => {},
}

/** Resolve a subagent model against the active lane's public model service. */
function resolveSubagentModel(
  subagent: SubagentConfig,
  current: RuntimeModelConfig,
  modelService: NonNullable<RuntimeExecutionServices["model"]>,
): { model: Model; apiKey: string | undefined; toolChoice: string } {
  if (current.useFallback) {
    return { model: current.fallbackModel, apiKey: current.fallbackApiKey, toolChoice: current.fallbackToolChoice }
  }
  if (subagent.model) {
    const preset = getModelPreset(subagent.model)
    if (preset) {
      const modelId = typeof preset.model === "string" ? preset.model.trim() : ""
      const apiKey = typeof preset.api_key === "string" ? preset.api_key.trim() : undefined
      if (modelId) {
        const built = modelService.resolveModelSwap(subagent.model).model
        if (built) return { model: built, apiKey: apiKey ?? current.primaryApiKey, toolChoice: current.primaryToolChoice }
      }
    }
    const built = buildModel(MODEL_PROVIDER, subagent.model, MODEL_BASE_URL || undefined, undefined, undefined, config.model.bridge, config.model.api_key)
    if (built) return { model: built, apiKey: current.primaryApiKey, toolChoice: current.primaryToolChoice }
  }
  if (current.primaryModel) {
    return { model: current.primaryModel, apiKey: current.primaryApiKey, toolChoice: current.primaryToolChoice }
  }
  return { model: current.fallbackModel, apiKey: current.fallbackApiKey, toolChoice: current.fallbackToolChoice }
}

/** Find a subagent config by name. Returns undefined if not found. */
export function findSubagent(name: string): SubagentConfig | undefined {
  return config.subagents.find((subagent) => subagent.name === name)
}

/** List all configured subagent names. */
export function listSubagentNames(): string[] {
  return config.subagents.map((subagent) => subagent.name)
}

function toolDefinitions(services: RuntimeExecutionServices, subagent: SubagentConfig, runtimeKind: RuntimeKind): Tool[] {
  const tools = services.tools
  if (!tools) throw new Error("subagent tools are unavailable")
  return tools.list(runtimeKind)
    .filter(({ definition }) => isToolEnabledForSubagent(definition.function.name, subagent.enabled_tools, subagent.blacklisted_tools))
    .map(({ definition }) => ({
      name: definition.function.name,
      description: definition.function.description,
      parameters: definition.function.parameters,
    }))
}


/**
 * Run a configured subagent with the active runtime's provider and public tool,
 * memory, metrics, and client services. No provider or tool registry is global.
 */
export async function runSubagent(
  convId: number,
  subagent: SubagentConfig,
  task: string,
  signal: AbortSignal | undefined,
  services: RuntimeExecutionServices,
  runtimeKind: RuntimeKind = "main",
): Promise<string> {
  if (!services.providerResolver) throw new Error("subagent provider resolver is unavailable")
  if (!services.tools) throw new Error("subagent tools are unavailable")
  const current = services.model?.current(runtimeKind)
  if (!current) throw new Error("subagent model service is unavailable")
  const { model, apiKey, toolChoice } = resolveSubagentModel(subagent, current, services.model!)
  const tools = toolDefinitions(services, subagent, runtimeKind)
  const systemPrompt = subagent.system_prompt
    ? `${subagent.system_prompt}\n\nYou are a subagent spawned by the main agent. You have ${subagent.max_turns} turns. Focus on your task and return your result when done. You do not have access to Discord or event-loop tools.`
    : `You are a subagent spawned by the main agent. You have ${subagent.max_turns} turns. Focus on your task and return your result when done. You do not have access to Discord or event-loop tools.`
  const state: LoopState = {
    runtimeKind,
    services,
    tokenCount: 0,
    contextSize: 0,
    pendingInputs: [],
    context: new Context({
      model,
      providerResolver: services.providerResolver,
      prepareMessages: services.images?.prepareMessages,
      systemPrompt,
      tools,
      apiKey,
      toolChoice: (current.enableThinking && toolChoice === "required" ? "auto" : toolChoice) as "required" | "auto" | "none",
      thinkingLevel: current.enableThinking ? current.thinkingEffort : undefined,
      includeContextImages: current.primaryVision,
      items: [{ role: "user", content: task, timestamp: Date.now() } as Message],
    }),
    toolCatalog: tools.map(({ name, description, parameters }) => ({
      type: "function",
      function: { name, description, parameters: parameters as JsonSchema },
    })),
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
  const enabledTools = new Set(tools.map((tool) => tool.name))
  console.log(`[subagent] spawning "${subagent.name}" (model=${model.id}, tools=${tools.map((tool) => tool.name).join(",")}, max_turns=${subagent.max_turns})`)

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
            services.events?.emit({ type: "text", text: `[subagent:${subagent.name}] ${event.delta}` })
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
    services.persistence?.logMessage(convId, "assistant", `[subagent:${subagent.name}] ${text}`, toolCalls.length > 0 ? toolCalls : undefined)
    if (toolCalls.length === 0) {
      console.log(`[subagent] "${subagent.name}" completed after ${turnCount} turns`)
      return lastText || "(subagent produced no output)"
    }
    for (const call of toolCalls) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("subagent interrupted")
      if (!enabledTools.has(call.name)) {
        recordToolResult(convId, state, call as FunctionToolCall, call.name, { _unavailable_tool: call.name }, `error: tool ${call.name} is unavailable to this subagent`)
        continue
      }
      await executeToolCall(convId, state, SUBAGENT_HOOKS, {}, call as FunctionToolCall)
    }
  }
  console.warn(`[subagent] "${subagent.name}" hit max_turns (${subagent.max_turns})`)
  return lastText || `(subagent "${subagent.name}" hit max_turns without producing output)`
}
/** Bind subagent execution to one plugin-scoped service set. */
export function createSubagentService(services: RuntimeExecutionServices): SubagentService {
  return {
    findSubagent,
    runSubagent: (convId, subagent, task, signal, runtimeKind) =>
      runSubagent(convId, subagent, task, signal, services, runtimeKind),
  }
}
