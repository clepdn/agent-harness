import type { Model } from "../llm"
import { config, getModelPreset, listModelPresets, type ToolChoice, type ThinkingEffort, type CompactionStrategy } from "../config"
import { codexServiceTier } from "../codex-fast-mode"
import { cacheLifetimeMinutes, idleCacheCompactionMs, respectPromptCache } from "../cache-policy"
import { atomicWriteFile, isMissingFileError } from "../durable-file"
import fs from "node:fs/promises"
import path from "node:path"
import type { RuntimeKind } from "./types"
import {
  buildModel,
  PRIMARY_TOOL_CHOICE as initPrimaryToolChoice,
  FALLBACK_TOOL_CHOICE as initFallbackToolChoice,
  ENABLE_THINKING as initEnableThinking,
  THINKING_EFFORT as initThinkingEffort,
  PRIMARY_VISION as initPrimaryVision,
  PRIMARY_NUDGE_ON_NO_TOOL as initPrimaryNudgeOnNoTool,
  PRIMARY_IDLE_COMPACTION_MS as initPrimaryIdleCompactionMs,
  RESPECT_PROMPT_CACHE as initRespectPromptCache,
  COMPACTION_STRATEGY as initCompactionStrategy,
  CONTEXT_COMPACT_TRIGGER_TOKENS as initCompactTriggerTokens,
  DEEP_ARCHIVE_ENABLED as initDeepArchive,
  USE_FALLBACK as initUseFallback,
  MODEL_PROVIDER,
  MODEL,
  MODEL_BASE_URL,
  FALLBACK_PROVIDER,
  FALLBACK_MODEL,
  FALLBACK_N_CTX,
  SUMMARY_PROVIDER,
  SUMMARY_MODEL,
} from "./config"
import type { BridgeModelMetadataResource, BridgeModelMetadataTarget } from "../bridge-model-metadata"

export interface RuntimeModelConfig {
  primaryModel: Model | null
  primaryApiKey: string | undefined
  primaryToolChoice: ToolChoice
  primaryVision: boolean
  primaryNudgeOnNoTool: boolean
  idleCompactionMs: number
  cacheWarming: boolean
  cacheWarmingDurationMs: number
  cacheWarmingMode: "completion" | "prewarm"
  cacheLifetimeMs: number
  enableThinking: boolean
  thinkingEffort: ThinkingEffort
  fallbackModel: Model
  fallbackApiKey: string | undefined
  fallbackToolChoice: ToolChoice
  summaryModel: Model | null
  summaryApiKey: string | undefined
  respectPromptCache: boolean
  compactionStrategy: CompactionStrategy
  compactTriggerTokens: number
  deepArchive: boolean
  useFallback: boolean
}

export interface ModelSwapSelection {
  preset: string
  model: Model
  apiKey: string | undefined
  toolChoice: ToolChoice
  fast: boolean
  enableThinking: boolean
  thinkingEffort: ThinkingEffort
  vision: boolean
  nudgeOnNoTool: boolean
  idleCompactionMs: number
  cacheWarming: boolean
  cacheWarmingDurationMs: number
  cacheWarmingMode: "completion" | "prewarm"
  cacheLifetimeMs: number
  compactionStrategy: CompactionStrategy
  compactTriggerTokens: number
  deepArchive: boolean
  respectPromptCache: boolean
}

export interface ModelStateFactoryOptions {
  readonly home: string
  readonly metadata?: BridgeModelMetadataResource
  readonly signal?: AbortSignal
}

export interface ModelStateResource {
  current(kind?: RuntimeKind): RuntimeModelConfig
  resolveModelSwap(preset: string): ModelSwapSelection
  applyModelSwap(selection: ModelSwapSelection): void
  persistModelSwap(selection: ModelSwapSelection): Promise<void>
  persistedPreset(): string | undefined
  getFastMode(): boolean
  setFastMode(enabled?: boolean): boolean
  serviceTier(model: Pick<Model, "id" | "provider">): "priority" | "default" | undefined
}

function isToolChoice(value: unknown): value is ToolChoice {
  return value === "required" || value === "auto" || value === "none"
}
function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
}
function isCompactionStrategy(value: unknown): value is CompactionStrategy {
  return value === "companion" || value === "context-full" || value === "snapcompact" || value === "remote" || value === "off"
}

/** Build one generation-owned model state resource and restore its selected preset. */
export async function createModelStateFactory(options: ModelStateFactoryOptions): Promise<ModelStateResource> {
  const metadata = options.metadata
  const capabilityFor = (modelId: string, baseUrl: string, explicitlyBridge = false, apiKey?: string) =>
    metadata?.lookup(modelId, baseUrl, explicitlyBridge, apiKey)
  const build = (
    provider: string,
    modelId: string,
    baseUrl?: string,
    headers?: Record<string, string>,
    contextWindow?: number,
    bridge = false,
    apiKey?: string,
  ) => buildModel(provider, modelId, baseUrl, headers, contextWindow, bridge, apiKey, capabilityFor(modelId, baseUrl ?? "", bridge, apiKey))
  const primaryInitial = !initUseFallback
    ? build(MODEL_PROVIDER, MODEL, MODEL_BASE_URL || undefined, undefined, undefined, config.model.bridge, config.model.api_key)
    : null
  const fallbackHeaders: Record<string, string> = {}
  if (config.fallback.referer) fallbackHeaders["HTTP-Referer"] = config.fallback.referer
  if (config.fallback.title) fallbackHeaders["X-Title"] = config.fallback.title
  const summaryHeaders: Record<string, string> = {}
  if (config.summary.referer) summaryHeaders["HTTP-Referer"] = config.summary.referer
  if (config.summary.title) summaryHeaders["X-Title"] = config.summary.title
  const fallbackInitial = build(
    FALLBACK_PROVIDER,
    FALLBACK_MODEL,
    config.fallback.base_url || undefined,
    Object.keys(fallbackHeaders).length ? fallbackHeaders : undefined,
    config.fallback.base_url ? FALLBACK_N_CTX : undefined,
    config.fallback.bridge,
    config.fallback.api_key,
  ) ?? {
    id: FALLBACK_MODEL,
    name: FALLBACK_MODEL,
    api: "openai-completions" as const,
    provider: "openai",
    baseUrl: "http://localhost:1234/v1",
    reasoning: false,
    input: ["text" as const, "image" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: FALLBACK_N_CTX,
    maxTokens: 4096,
  }
  const summaryInitial = SUMMARY_MODEL
    ? build(SUMMARY_PROVIDER, SUMMARY_MODEL, config.summary.base_url || undefined, Object.keys(summaryHeaders).length ? summaryHeaders : undefined, undefined, config.summary.bridge, config.summary.api_key)
    : null

  const state: RuntimeModelConfig = {
    primaryModel: primaryInitial,
    primaryApiKey: config.model.api_key || undefined,
    primaryToolChoice: initPrimaryToolChoice,
    primaryVision: initPrimaryVision,
    primaryNudgeOnNoTool: initPrimaryNudgeOnNoTool,
    idleCompactionMs: initPrimaryIdleCompactionMs,
    cacheWarming: config.model.cache_warming,
    cacheWarmingDurationMs: config.model.cache_warming_minutes * 60_000,
    cacheWarmingMode: config.model.cache_warming_mode,
    cacheLifetimeMs: config.model.cache_lifetime_minutes * 60_000,
    enableThinking: initEnableThinking,
    thinkingEffort: initThinkingEffort,
    fallbackModel: fallbackInitial,
    fallbackApiKey: config.fallback.api_key || undefined,
    fallbackToolChoice: initFallbackToolChoice,
    summaryModel: summaryInitial,
    summaryApiKey: config.summary.api_key || undefined,
    respectPromptCache: initRespectPromptCache,
    compactionStrategy: initCompactionStrategy,
    compactTriggerTokens: initCompactTriggerTokens,
    deepArchive: initDeepArchive,
    useFallback: initUseFallback,
  }
  const startupDefaults = {
    primaryToolChoice: state.primaryToolChoice,
    primaryVision: state.primaryVision,
    primaryNudgeOnNoTool: state.primaryNudgeOnNoTool,
    enableThinking: state.enableThinking,
    thinkingEffort: state.thinkingEffort,
    respectPromptCache: state.respectPromptCache,
    compactionStrategy: state.compactionStrategy,
    compactTriggerTokens: state.compactTriggerTokens,
    deepArchive: state.deepArchive,
  }

  const frontendState = (): RuntimeModelConfig | null => {
    const configured = config.frontend.preset
    if (configured === undefined) return null
    const source = getModelPreset(configured)
    if (!source) throw new Error(`model preset ${JSON.stringify(configured)} not found in [models]`)
    const provider = typeof source.provider === "string" ? source.provider.trim() : config.model.provider
    const modelId = typeof source.model === "string" ? source.model.trim() : ""
    const baseUrl = typeof source.base_url === "string" ? source.base_url.trim() : config.model.base_url
    const apiKey = typeof source.api_key === "string" && source.api_key.trim() ? source.api_key.trim() : config.model.api_key || undefined
    const contextWindow = typeof source.context_window === "number" && source.context_window > 0 ? source.context_window : undefined
    const headers: Record<string, string> = {}
    if (typeof source.referer === "string" && source.referer.trim()) headers["HTTP-Referer"] = source.referer.trim()
    if (typeof source.title === "string" && source.title.trim()) headers["X-Title"] = source.title.trim()
    const primaryModel = build(provider, modelId, baseUrl || undefined, Object.keys(headers).length ? headers : undefined, contextWindow, source.bridge === true, apiKey)
    const toolChoice = isToolChoice(source.tool_choice) ? source.tool_choice : startupDefaults.primaryToolChoice
    const thinkingEffort = isThinkingEffort(source.thinking_effort) ? source.thinking_effort : startupDefaults.thinkingEffort
    const compactionStrategy = isCompactionStrategy(source.compaction_strategy) ? source.compaction_strategy : startupDefaults.compactionStrategy
    const cacheWarming = typeof source.cache_warming === "boolean" ? source.cache_warming : false
    const cacheLifetimeMs = cacheLifetimeMinutes(source) * 60_000
    const respectCache = respectPromptCache(source, startupDefaults.respectPromptCache)
    return {
      ...state,
      primaryModel,
      primaryApiKey: apiKey,
      primaryToolChoice: toolChoice,
      primaryVision: typeof source.vision === "boolean" ? source.vision : startupDefaults.primaryVision,
      primaryNudgeOnNoTool: typeof source.nudge_on_no_tool === "boolean" ? source.nudge_on_no_tool : startupDefaults.primaryNudgeOnNoTool,
      enableThinking: typeof source.enable_thinking === "boolean" ? source.enable_thinking : startupDefaults.enableThinking,
      thinkingEffort,
      idleCompactionMs: idleCacheCompactionMs(cacheLifetimeMs, respectCache, cacheWarming),
      cacheWarming,
      cacheWarmingDurationMs: typeof source.cache_warming_minutes === "number" && Number.isFinite(source.cache_warming_minutes) ? Math.max(0, source.cache_warming_minutes * 60_000) : 0,
      cacheWarmingMode: source.cache_warming_mode === "prewarm" || source.cache_warming_mode === "completion" ? source.cache_warming_mode : "completion",
      cacheLifetimeMs,
      compactionStrategy,
      compactTriggerTokens: typeof source.compact_trigger_tokens === "number" && source.compact_trigger_tokens > 0 ? Math.trunc(source.compact_trigger_tokens) : startupDefaults.compactTriggerTokens,
      deepArchive: typeof source.deep_archive === "boolean" ? source.deep_archive : startupDefaults.deepArchive,
      respectPromptCache: respectCache,
      useFallback: false,
    }
  }
  let frontendCache: RuntimeModelConfig | null | undefined
  const current = (kind?: RuntimeKind): RuntimeModelConfig => {
    if (kind !== "frontend" || config.frontend.preset === undefined) return state
    if (frontendCache === undefined) frontendCache = frontendState()
    return frontendCache ?? state
  }
  let fast = config.model.fast
  let persisted: string | undefined
  const resolveModelSwap = (presetName: string): ModelSwapSelection => {
    const name = presetName.trim()
    const preset = getModelPreset(name)
    if (!preset) throw new Error(`model preset "${name}" not found in [models]`)
    const provider = typeof preset.provider === "string" ? preset.provider.trim() : ""
    const modelId = typeof preset.model === "string" ? preset.model.trim() : ""
    const baseUrl = typeof preset.base_url === "string" ? preset.base_url.trim() : ""
    const apiKey = typeof preset.api_key === "string" ? preset.api_key.trim() : undefined
    if (!modelId) throw new Error(`preset "${name}" has no model field`)
    const contextWindow = typeof preset.context_window === "number" ? preset.context_window : 200_000
    const headers: Record<string, string> = {}
    const referer = typeof preset.referer === "string" ? preset.referer.trim() : ""
    const title = typeof preset.title === "string" ? preset.title.trim() : ""
    if (referer) headers["HTTP-Referer"] = referer
    if (title) headers["X-Title"] = title
    const model = build(provider, modelId, baseUrl || undefined, Object.keys(headers).length ? headers : undefined, contextWindow !== 200_000 ? contextWindow : undefined, preset.bridge === true, apiKey)
    if (!model) throw new Error(`failed to build model from preset "${name}"`)
    const toolChoice = isToolChoice(preset.tool_choice) ? preset.tool_choice : startupDefaults.primaryToolChoice
    const enableThinking = typeof preset.enable_thinking === "boolean" ? preset.enable_thinking : startupDefaults.enableThinking
    const thinkingEffort = isThinkingEffort(preset.thinking_effort) ? preset.thinking_effort : startupDefaults.thinkingEffort
    const vision = typeof preset.vision === "boolean" ? preset.vision : startupDefaults.primaryVision
    const nudgeOnNoTool = typeof preset.nudge_on_no_tool === "boolean" ? preset.nudge_on_no_tool : startupDefaults.primaryNudgeOnNoTool
    const compactionStrategy = isCompactionStrategy(preset.compaction_strategy) ? preset.compaction_strategy : startupDefaults.compactionStrategy
    const compactTriggerTokens = typeof preset.compact_trigger_tokens === "number" && preset.compact_trigger_tokens > 0 ? preset.compact_trigger_tokens : startupDefaults.compactTriggerTokens
    const deepArchive = typeof preset.deep_archive === "boolean" ? preset.deep_archive : startupDefaults.deepArchive
    const respectCache = respectPromptCache(preset, startupDefaults.respectPromptCache)
    const cacheWarming = typeof preset.cache_warming === "boolean" ? preset.cache_warming : false
    const cacheLifetimeMs = cacheLifetimeMinutes(preset) * 60_000
    return {
      preset: name,
      model,
      apiKey: apiKey || undefined,
      toolChoice,
      fast: typeof preset.fast === "boolean" ? preset.fast : false,
      enableThinking,
      thinkingEffort,
      vision,
      nudgeOnNoTool,
      idleCompactionMs: idleCacheCompactionMs(cacheLifetimeMs, respectCache, cacheWarming),
      cacheWarming,
      cacheWarmingDurationMs: typeof preset.cache_warming_minutes === "number" && Number.isFinite(preset.cache_warming_minutes) ? Math.max(0, preset.cache_warming_minutes * 60_000) : 0,
      cacheWarmingMode: preset.cache_warming_mode === "prewarm" || preset.cache_warming_mode === "completion" ? preset.cache_warming_mode : "completion",
      cacheLifetimeMs,
      compactionStrategy,
      compactTriggerTokens,
      deepArchive,
      respectPromptCache: respectCache,
    }
  }
  const applyModelSwap = (selection: ModelSwapSelection): void => {
    state.primaryModel = selection.model
    state.primaryApiKey = selection.apiKey
    state.primaryToolChoice = selection.toolChoice
    state.useFallback = false
    fast = selection.fast
    state.primaryVision = selection.vision
    state.primaryNudgeOnNoTool = selection.nudgeOnNoTool
    state.idleCompactionMs = selection.idleCompactionMs
    state.cacheWarming = selection.cacheWarming
    state.cacheWarmingDurationMs = selection.cacheWarmingDurationMs
    state.cacheWarmingMode = selection.cacheWarmingMode
    state.cacheLifetimeMs = selection.cacheLifetimeMs
    state.compactionStrategy = selection.compactionStrategy
    state.compactTriggerTokens = selection.compactTriggerTokens
    state.deepArchive = selection.deepArchive
    state.respectPromptCache = selection.respectPromptCache
    state.enableThinking = selection.enableThinking
    state.thinkingEffort = selection.thinkingEffort
    console.log(`[model-swap] swapped primary model to ${selection.model.id} (provider=${selection.model.provider}, base=${selection.model.baseUrl}, vision=${selection.vision})`)
  }
  const selectionPath = path.join(path.resolve(options.home), "model-selection.json")
  const persistModelSwap = async (selection: ModelSwapSelection): Promise<void> => {
    resolveModelSwap(selection.preset)
    await atomicWriteFile(selectionPath, `${JSON.stringify({ preset: selection.preset })}\n`, 0o600)
    persisted = selection.preset
  }
  const targets: BridgeModelMetadataTarget[] = []
  const addTarget = (model: Model | null, apiKey?: string) => { if (model) targets.push({ model, apiKey }) }
  addTarget(state.primaryModel, state.primaryApiKey)
  addTarget(state.fallbackModel, state.fallbackApiKey)
  addTarget(state.summaryModel, state.summaryApiKey)
  if (config.frontend.enable) {
    const frontend = current("frontend")
    addTarget(frontend.primaryModel, frontend.primaryApiKey)
    addTarget(frontend.fallbackModel, frontend.fallbackApiKey)
    addTarget(frontend.summaryModel, frontend.summaryApiKey)
  }
  for (const name of listModelPresets()) {
    const preset = getModelPreset(name)
    if (!preset || typeof preset.model !== "string" || !preset.model.trim()) continue
    const provider = typeof preset.provider === "string" ? preset.provider.trim() : config.model.provider
    const baseUrl = typeof preset.base_url === "string" ? preset.base_url.trim() : config.model.base_url
    const apiKey = typeof preset.api_key === "string" && preset.api_key.trim() ? preset.api_key.trim() : config.model.api_key || undefined
    addTarget(build(provider, preset.model.trim(), baseUrl || undefined, undefined, undefined, preset.bridge === true, apiKey), apiKey)
  }
  if (metadata) {
    await metadata.initialize(targets, options.signal)
    metadata.hydrate(targets)
  }
  let contents: string | undefined
  try {
    contents = await fs.readFile(selectionPath, "utf8")
  } catch (error) {
    if (!isMissingFileError(error)) throw new Error(`failed to read persisted model selection at ${selectionPath}: ${String(error)}`, { cause: error })
    contents = undefined
  }
  if (contents !== undefined) {
    let value: unknown
    try { value = JSON.parse(contents) } catch (error) { throw new Error(`malformed persisted model selection at ${selectionPath}: invalid JSON`, { cause: error }) }
    if (!value || typeof value !== "object" || !("preset" in value) || typeof value.preset !== "string" || !value.preset.trim() || Object.keys(value).length !== 1) throw new Error(`malformed persisted model selection at ${selectionPath}: expected only a non-empty preset name`)
    const preset = value.preset.trim()
    let selection: ModelSwapSelection
    try { selection = resolveModelSwap(preset) } catch (error) { throw new Error(`cannot restore persisted model preset "${preset}": ${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
    persisted = preset
    applyModelSwap(selection)
  }
  return {
    current,
    resolveModelSwap,
    applyModelSwap,
    persistModelSwap,
    persistedPreset: () => persisted,
    getFastMode: () => fast,
    setFastMode: (enabled = !fast) => { fast = enabled; return fast },
    serviceTier: (model) => codexServiceTier(model, fast),
  }
}
