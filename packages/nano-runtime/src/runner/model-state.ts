/**
 * Mutable runtime model state.
 *
 * The harness resolves model configuration (provider, api_key, thinking, etc.)
 * from JSON presets at startup. This module holds that resolved config in a
 * mutable singleton so it can be swapped at runtime via the model-swap feature.
 *
 * All code that makes LLM API calls reads from `modelState` rather than the
 * const exports in `config.ts`. This allows `POST /awp/swap-model` to swap
 * the primary model mid-session.
 */

import type { Model } from "../llm"
import { config, getModelPreset, type ToolChoice, type ThinkingEffort, type CompactionStrategy } from "../config"
import { setCodexFastMode } from "../codex-fast-mode"
import { cacheLifetimeMinutes, idleCacheCompactionMs, respectPromptCache } from "../cache-policy"
import type { RuntimeKind } from "./types"
import {
  buildModel,
  primaryModel as initPrimaryModel,
  fallbackModel as initFallbackModel,
  summaryModel as initSummaryModel,
  PRIMARY_API_KEY as initPrimaryKey,
  FALLBACK_API_KEY as initFallbackKey,
  SUMMARY_API_KEY as initSummaryKey,
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
} from "./config"

export interface RuntimeModelConfig {
  // Primary model (swappable)
  primaryModel: Model | null
  primaryApiKey: string | undefined
  primaryToolChoice: ToolChoice
  primaryVision: boolean
  primaryNudgeOnNoTool: boolean
  // Derived from cache lifetime and respect; warming owns its own budget.
  idleCompactionMs: number
  cacheWarming: boolean
  cacheWarmingDurationMs: number
  cacheWarmingMode: "completion" | "prewarm"
  cacheLifetimeMs: number
  enableThinking: boolean
  thinkingEffort: ThinkingEffort

  // Fallback model (unchanged by swaps)
  fallbackModel: Model
  fallbackApiKey: string | undefined
  fallbackToolChoice: ToolChoice

  // Summary model (unchanged by swaps)
  summaryModel: Model | null
  summaryApiKey: string | undefined

  // Context behavior (per-model preset options, swap with the model at runtime)
  respectPromptCache: boolean
  compactionStrategy: CompactionStrategy
  compactTriggerTokens: number
  deepArchive: boolean

  // Flags
  useFallback: boolean
}

// ── Initialization from config consts ───────────────────────────────────────

export const modelState: RuntimeModelConfig = {
  primaryModel: initPrimaryModel,
  primaryApiKey: initPrimaryKey,
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

  fallbackModel: initFallbackModel,
  fallbackApiKey: initFallbackKey,
  fallbackToolChoice: initFallbackToolChoice,

  summaryModel: initSummaryModel,
  summaryApiKey: initSummaryKey,

  respectPromptCache: initRespectPromptCache,
  compactionStrategy: initCompactionStrategy,
  compactTriggerTokens: initCompactTriggerTokens,
  deepArchive: initDeepArchive,
  useFallback: initUseFallback,
}

function frontendModelConfig(): RuntimeModelConfig | null {
  const configured = config.frontend.preset
  if (configured === undefined) return null

  const preset = getModelPreset(configured)
  if (!preset) throw new Error(`model preset ${JSON.stringify(configured)} not found in [models]`)
  const source = preset
  const provider = typeof source.provider === "string" ? source.provider.trim() : config.model.provider
  const modelId = typeof source.model === "string" ? source.model.trim() : ""
  const baseUrl = typeof source.base_url === "string" ? source.base_url.trim() : config.model.base_url
  const apiKey = typeof source.api_key === "string" && source.api_key.trim()
    ? source.api_key.trim()
    : config.model.api_key || undefined
  const contextWindow = typeof source.context_window === "number" && source.context_window > 0
    ? source.context_window
    : undefined
  const headers: Record<string, string> = {}
  if (typeof source.referer === "string" && source.referer.trim()) headers["HTTP-Referer"] = source.referer.trim()
  if (typeof source.title === "string" && source.title.trim()) headers["X-Title"] = source.title.trim()
  const primaryModel = buildModel(
    provider,
    modelId,
    baseUrl || undefined,
    Object.keys(headers).length ? headers : undefined,
    contextWindow,
    source.bridge === true,
    apiKey,
  )

  const toolChoice: ToolChoice =
    typeof source.tool_choice === "string" && ["required", "auto", "none"].includes(source.tool_choice)
      ? source.tool_choice as ToolChoice
      : modelState.primaryToolChoice
  const thinkingEffort: ThinkingEffort =
    typeof source.thinking_effort === "string" && ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(source.thinking_effort)
      ? source.thinking_effort as ThinkingEffort
      : modelState.thinkingEffort
  const compactionStrategy: CompactionStrategy =
    typeof source.compaction_strategy === "string" && ["companion", "context-full", "snapcompact", "remote", "off"].includes(source.compaction_strategy)
      ? source.compaction_strategy as CompactionStrategy
      : modelState.compactionStrategy

  const cacheWarming = typeof source.cache_warming === "boolean" ? source.cache_warming : false
  const cacheLifetimeMs = cacheLifetimeMinutes(source) * 60_000
  const respectCache = respectPromptCache(source, modelState.respectPromptCache)

  return {
    ...modelState,
    primaryModel,
    primaryApiKey: apiKey,
    primaryToolChoice: toolChoice,
    primaryVision: typeof source.vision === "boolean" ? source.vision : modelState.primaryVision,
    primaryNudgeOnNoTool: typeof source.nudge_on_no_tool === "boolean" ? source.nudge_on_no_tool : modelState.primaryNudgeOnNoTool,
    enableThinking: typeof source.enable_thinking === "boolean" ? source.enable_thinking : modelState.enableThinking,
    thinkingEffort,
    idleCompactionMs: idleCacheCompactionMs(cacheLifetimeMs, respectCache, cacheWarming),
    cacheWarming,
    cacheWarmingDurationMs: typeof source.cache_warming_minutes === "number" && Number.isFinite(source.cache_warming_minutes)
      ? Math.max(0, source.cache_warming_minutes * 60_000)
      : 0,
    cacheWarmingMode: source.cache_warming_mode === "prewarm" || source.cache_warming_mode === "completion"
      ? source.cache_warming_mode : "completion",
    cacheLifetimeMs,
    compactionStrategy,
    compactTriggerTokens: typeof source.compact_trigger_tokens === "number" && source.compact_trigger_tokens > 0
      ? Math.trunc(source.compact_trigger_tokens)
      : modelState.compactTriggerTokens,
    deepArchive: typeof source.deep_archive === "boolean" ? source.deep_archive : modelState.deepArchive,
    respectPromptCache: respectCache,
    useFallback: false,
  }
}

let fixedFrontendModelState: RuntimeModelConfig | null | undefined

/** Resolve the model state for a virtual runner. Undefined frontend.preset is live inheritance. */
export function modelStateFor(kind: RuntimeKind | undefined): RuntimeModelConfig {
  if (kind !== "frontend" || config.frontend.preset === undefined) return modelState
  if (fixedFrontendModelState === undefined) fixedFrontendModelState = frontendModelConfig()
  return fixedFrontendModelState ?? modelState
}

// ── Swap logic ────────────────────────────────────────────────────────────────

export type SwapDecision =
  | {
      action: "swap"
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
  | { action: "rest"; preset: string; reason: string }

/**
 * Evaluates whether swapping to a named preset is compatible with the current
 * session context.
 *
 * Rest is triggered when:
 *   - The current session preserves its prompt cache (model swaps invalidate it)
 *   - The new model's context window is smaller than the current context size
 *
 * Otherwise the swap is compatible and the context carries over.
 *
 * @param presetName  Name of the preset defined under [models.<name>]
 * @param currentContextSize  Current prompt token count (state.contextSize)
 */
export function evaluateModelSwap(presetName: string, currentContextSize: number): SwapDecision {
  const preset = getModelPreset(presetName)
  if (!preset) {
    throw new Error(`model preset "${presetName}" not found in [models]`)
  }

  const provider = typeof preset.provider === "string" ? preset.provider.trim() : ""
  const modelId = typeof preset.model === "string" ? preset.model.trim() : ""
  const baseUrl = typeof preset.base_url === "string" ? preset.base_url.trim() : ""
  const apiKey = typeof preset.api_key === "string" ? preset.api_key.trim() : undefined

  if (!modelId) {
    throw new Error(`preset "${presetName}" has no model field`)
  }

  // Presets can optionally specify context_window for compatibility checking.
  // Defaults to 200_000 (same as buildModel).
  const contextWindow =
    typeof preset.context_window === "number" ? preset.context_window : 200_000

  // Build headers from optional referer/title fields
  const headers: Record<string, string> = {}
  const referer = typeof preset.referer === "string" ? preset.referer.trim() : ""
  const title = typeof preset.title === "string" ? preset.title.trim() : ""
  if (referer) headers["HTTP-Referer"] = referer
  if (title) headers["X-Title"] = title

  const model = buildModel(
    provider,
    modelId,
    baseUrl || undefined,
    Object.keys(headers).length ? headers : undefined,
    contextWindow !== 200_000 ? contextWindow : undefined,
    preset.bridge === true,
    apiKey,
  )
  if (!model) {
    throw new Error(`failed to build model from preset "${presetName}"`)
  }

  // Compatibility check 1: respecting the CURRENT model's prompt cache means a
  // model swap would invalidate its tokenizer/prefix. Must rest. This reads the
  // current runtime value (not the target preset) on purpose — it's the session
  // we're protecting, not the model we're moving to.
  if (modelState.respectPromptCache) {
    return {
      action: "rest",
      preset: presetName,
      reason: `respecting the prompt cache requires a rest before swapping to "${presetName}"`,
    }
  }

  // Compatibility check 2: if the new model's context window is smaller than
  // the current context size, the conversation won't fit. Must rest.
  if (contextWindow < currentContextSize) {
    return {
      action: "rest",
      preset: presetName,
      reason: `new model context window (${contextWindow}) < current context size (${currentContextSize})`,
    }
  }

  // Resolve remaining primary model settings from the preset
  const toolChoice: ToolChoice =
    typeof preset.tool_choice === "string" && ["required", "auto", "none"].includes(preset.tool_choice as string)
      ? (preset.tool_choice as ToolChoice)
      : modelState.primaryToolChoice

  const enableThinking =
    typeof preset.enable_thinking === "boolean" ? preset.enable_thinking : modelState.enableThinking

  const fast = typeof preset.fast === "boolean" ? preset.fast : false

  const thinkingEffort: ThinkingEffort =
    typeof preset.thinking_effort === "string" &&
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(preset.thinking_effort as string)
      ? preset.thinking_effort as ThinkingEffort
      : modelState.thinkingEffort

  const vision =
    typeof preset.vision === "boolean" ? preset.vision : modelState.primaryVision

  const nudgeOnNoTool =
    typeof preset.nudge_on_no_tool === "boolean" ? preset.nudge_on_no_tool : modelState.primaryNudgeOnNoTool

  // Per-model context behavior. Each falls back to the current runtime value
  // when the target preset doesn't specify it, so a swap never silently resets
  // a knob the new preset was quiet about.
  const compactionStrategy: CompactionStrategy =
    typeof preset.compaction_strategy === "string" &&
    ["companion", "context-full", "snapcompact", "remote", "off"].includes(preset.compaction_strategy as string)
      ? (preset.compaction_strategy as CompactionStrategy)
      : modelState.compactionStrategy

  const compactTriggerTokens =
    typeof preset.compact_trigger_tokens === "number" && preset.compact_trigger_tokens > 0
      ? preset.compact_trigger_tokens
      : modelState.compactTriggerTokens

  const deepArchive =
    typeof preset.deep_archive === "boolean" ? preset.deep_archive : modelState.deepArchive

  const respectCache = respectPromptCache(preset, modelState.respectPromptCache)
  const cacheWarming = typeof preset.cache_warming === "boolean" ? preset.cache_warming : false
  const cacheLifetimeMs = cacheLifetimeMinutes(preset) * 60_000

  return {
    action: "swap",
    preset: presetName,
    model,
    apiKey: apiKey || undefined,
    toolChoice,
    fast,
    enableThinking,
    thinkingEffort,
    vision,
    nudgeOnNoTool,
    idleCompactionMs: idleCacheCompactionMs(cacheLifetimeMs, respectCache, cacheWarming),
    cacheWarming,
    cacheWarmingDurationMs: typeof preset.cache_warming_minutes === "number" && Number.isFinite(preset.cache_warming_minutes)
      ? Math.max(0, preset.cache_warming_minutes * 60_000)
      : 0,
    cacheWarmingMode: preset.cache_warming_mode === "prewarm" || preset.cache_warming_mode === "completion"
      ? preset.cache_warming_mode : "completion",
    cacheLifetimeMs,
    compactionStrategy,
    compactTriggerTokens,
    deepArchive,
    respectPromptCache: respectCache,
  }
}

/**
 * Applies a compatible model swap to the runtime model state.
 * Only call this after `evaluateModelSwap` returns `{ action: "swap" }`.
 */
export function applyModelSwap(decision: Extract<SwapDecision, { action: "swap" }>): void {
  modelState.primaryModel = decision.model
  modelState.primaryApiKey = decision.apiKey
  modelState.primaryToolChoice = decision.toolChoice
  setCodexFastMode(decision.fast)
  modelState.primaryVision = decision.vision
  modelState.primaryNudgeOnNoTool = decision.nudgeOnNoTool
  modelState.idleCompactionMs = decision.idleCompactionMs
  modelState.cacheWarming = decision.cacheWarming
  modelState.cacheWarmingDurationMs = decision.cacheWarmingDurationMs
  modelState.cacheWarmingMode = decision.cacheWarmingMode
  modelState.cacheLifetimeMs = decision.cacheLifetimeMs
  modelState.compactionStrategy = decision.compactionStrategy
  modelState.compactTriggerTokens = decision.compactTriggerTokens
  modelState.deepArchive = decision.deepArchive
  modelState.respectPromptCache = decision.respectPromptCache
  modelState.enableThinking = decision.enableThinking
  modelState.thinkingEffort = decision.thinkingEffort

  console.log(
    `[model-swap] swapped primary model to ${decision.model.id} ` +
      `(provider=${decision.model.provider}, base=${decision.model.baseUrl}, vision=${decision.vision})`,
  )
}
