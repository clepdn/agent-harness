import type { ToolDefinition } from "@nano/harness-core"
import { Context, type ContextEffortState, type ContextForkReason, type Message } from "../llm"
import { modelStateFor } from "./model-state"
import { getCompletionTools } from "./tools"
import type { RuntimeKind } from "./types"

type RestoredLineage = {
  id?: string
  parentId?: string
  forkReason?: ContextForkReason
  configurationFingerprint?: string
  modelId?: string
  effortState?: ContextEffortState
}

/** Build a Context from the settings that are active for one runtime lane. */
export function createRuntimeContext(
  runtimeKind: RuntimeKind,
  items: readonly Message[] = [],
  toolCatalog?: ToolDefinition[],
  lineage?: RestoredLineage,
): Context {
  const state = modelStateFor(runtimeKind)
  const usingFallback = state.useFallback || !state.primaryModel
  const model = usingFallback ? state.fallbackModel : state.primaryModel!
  const sameModel = !lineage?.modelId || lineage.modelId === model.id
  const configuredEffort = state.enableThinking ? state.thinkingEffort : undefined
  const savedEffortState = sameModel ? lineage?.effortState : undefined
  const supportsUpdates = Boolean(model.bridge && model.effortCapabilities?.changeMode === "configuration-update" && model.effortCapabilities.supportedEfforts.length)
  const savedActiveEffort = savedEffortState?.updates.at(-1)?.effort ?? savedEffortState?.initialEffort
  const preserveEffortState = Boolean(savedEffortState && (!savedEffortState.updates.length || supportsUpdates))
  const rebaseUnavailableTimeline = Boolean(savedEffortState?.updates.length && !supportsUpdates && savedActiveEffort)
  const effortState = preserveEffortState ? savedEffortState
    : rebaseUnavailableTimeline ? { initialEffort: savedActiveEffort, updates: [] }
    : undefined
  const thinkingLevel = effortState?.initialEffort ?? configuredEffort
  const identity = lineage ? {
    id: lineage.id,
    parentId: lineage.parentId,
    forkReason: lineage.forkReason,
  } : {}
  const options = {
    model,
    apiKey: usingFallback ? state.fallbackApiKey : state.primaryApiKey,
    tools: getCompletionTools(toolCatalog, runtimeKind),
    toolChoice: usingFallback ? state.fallbackToolChoice : state.primaryToolChoice,
    thinkingLevel,
    ...(effortState ? { effortState } : {}),
    includeContextImages: state.primaryVision,
    items,
    ...identity,
  }
  if (!lineage) return new Context(options)
  const restored = Context.restore(options)
  if (rebaseUnavailableTimeline) {
    return restored.fork({
      thinkingLevel,
      effortState: { initialEffort: thinkingLevel, updates: [] },
      allowCacheReset: true,
      reason: "settings-change",
    })
  }
  if (!lineage.configurationFingerprint || lineage.configurationFingerprint === restored.configurationFingerprint) {
    return restored
  }
  return restored.fork({
    reason: lineage.modelId && lineage.modelId !== model.id ? "model-change" : "settings-change",
  })
}
