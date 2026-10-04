/**
 * Mutable runtime model state.
 *
 * The harness resolves model configuration (provider, api_key, thinking, etc.)
 * from JSON presets at startup. This module holds that resolved config in a
 * mutable singleton so it can be swapped at runtime via the model-swap feature.
 *
 * All code that makes LLM API calls reads from `modelState` rather than the
 * const exports in `config.ts`. Runtime selection is durably recorded by preset
 * name and restored from the current config at startup.
 */

import type { Model } from "../llm"
import { config, getModelPreset, type ToolChoice, type ThinkingEffort, type CompactionStrategy } from "../config"
import { setCodexFastMode } from "../codex-fast-mode"
import { cacheLifetimeMinutes, idleCacheCompactionMs, respectPromptCache } from "../cache-policy"
import { NANO_HOME } from "../agent-config"
import { atomicWriteFile, isMissingFileError } from "../durable-file"
import fs from "node:fs/promises"
import path from "node:path"
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

// Preset omissions inherit the configured startup defaults, never a prior swap.
// Preserving this boundary makes a stored preset name resolve identically after restart.
const startupModelDefaults = {
  primaryToolChoice: modelState.primaryToolChoice,
  primaryVision: modelState.primaryVision,
  primaryNudgeOnNoTool: modelState.primaryNudgeOnNoTool,
  enableThinking: modelState.enableThinking,
  thinkingEffort: modelState.thinkingEffort,
  respectPromptCache: modelState.respectPromptCache,
  compactionStrategy: modelState.compactionStrategy,
  compactTriggerTokens: modelState.compactTriggerTokens,
  deepArchive: modelState.deepArchive,
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
      : startupModelDefaults.primaryToolChoice
  const thinkingEffort: ThinkingEffort =
    typeof source.thinking_effort === "string" && ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(source.thinking_effort)
      ? source.thinking_effort as ThinkingEffort
      : startupModelDefaults.thinkingEffort
  const compactionStrategy: CompactionStrategy =
    typeof source.compaction_strategy === "string" && ["companion", "context-full", "snapcompact", "remote", "off"].includes(source.compaction_strategy)
      ? source.compaction_strategy as CompactionStrategy
      : startupModelDefaults.compactionStrategy

  const cacheWarming = typeof source.cache_warming === "boolean" ? source.cache_warming : false
  const cacheLifetimeMs = cacheLifetimeMinutes(source) * 60_000
  const respectCache = respectPromptCache(source, startupModelDefaults.respectPromptCache)

  return {
    ...modelState,
    primaryModel,
    primaryApiKey: apiKey,
    primaryToolChoice: toolChoice,
    primaryVision: typeof source.vision === "boolean" ? source.vision : startupModelDefaults.primaryVision,
    primaryNudgeOnNoTool: typeof source.nudge_on_no_tool === "boolean" ? source.nudge_on_no_tool : startupModelDefaults.primaryNudgeOnNoTool,
    enableThinking: typeof source.enable_thinking === "boolean" ? source.enable_thinking : startupModelDefaults.enableThinking,
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
      : startupModelDefaults.compactTriggerTokens,
    deepArchive: typeof source.deep_archive === "boolean" ? source.deep_archive : startupModelDefaults.deepArchive,
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

// ── Named model selection ─────────────────────────────────────────────────────

/** Fully resolved primary-model settings for a named preset. */
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

const MODEL_SELECTION_PATH = path.join(NANO_HOME, "model-selection.json")

/** Resolve all settings for a named preset, independent of current session state. */
export function resolveModelSwap(presetName: string): ModelSwapSelection {
  const name = presetName.trim()
  const preset = getModelPreset(name)
  if (!preset) {
    throw new Error(`model preset "${name}" not found in [models]`)
  }

  const provider = typeof preset.provider === "string" ? preset.provider.trim() : ""
  const modelId = typeof preset.model === "string" ? preset.model.trim() : ""
  const baseUrl = typeof preset.base_url === "string" ? preset.base_url.trim() : ""
  const apiKey = typeof preset.api_key === "string" ? preset.api_key.trim() : undefined

  if (!modelId) {
    throw new Error(`preset "${name}" has no model field`)
  }

  const contextWindow = typeof preset.context_window === "number" ? preset.context_window : 200_000
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
    throw new Error(`failed to build model from preset "${name}"`)
  }

  const toolChoice: ToolChoice =
    typeof preset.tool_choice === "string" && ["required", "auto", "none"].includes(preset.tool_choice)
      ? preset.tool_choice as ToolChoice
      : startupModelDefaults.primaryToolChoice

  const enableThinking =
    typeof preset.enable_thinking === "boolean" ? preset.enable_thinking : startupModelDefaults.enableThinking
  const fast = typeof preset.fast === "boolean" ? preset.fast : false
  const thinkingEffort: ThinkingEffort =
    typeof preset.thinking_effort === "string" &&
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(preset.thinking_effort)
      ? preset.thinking_effort as ThinkingEffort
      : startupModelDefaults.thinkingEffort
  const vision = typeof preset.vision === "boolean" ? preset.vision : startupModelDefaults.primaryVision
  const nudgeOnNoTool =
    typeof preset.nudge_on_no_tool === "boolean" ? preset.nudge_on_no_tool : startupModelDefaults.primaryNudgeOnNoTool
  const compactionStrategy: CompactionStrategy =
    typeof preset.compaction_strategy === "string" &&
    ["companion", "context-full", "snapcompact", "remote", "off"].includes(preset.compaction_strategy)
      ? preset.compaction_strategy as CompactionStrategy
      : startupModelDefaults.compactionStrategy
  const compactTriggerTokens =
    typeof preset.compact_trigger_tokens === "number" && preset.compact_trigger_tokens > 0
      ? preset.compact_trigger_tokens
      : startupModelDefaults.compactTriggerTokens
  const deepArchive =
    typeof preset.deep_archive === "boolean" ? preset.deep_archive : startupModelDefaults.deepArchive
  const respectCache = respectPromptCache(preset, startupModelDefaults.respectPromptCache)
  const cacheWarming = typeof preset.cache_warming === "boolean" ? preset.cache_warming : false
  const cacheLifetimeMs = cacheLifetimeMinutes(preset) * 60_000
  return {
    preset: name,
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
    cacheWarmingDurationMs:
      typeof preset.cache_warming_minutes === "number" && Number.isFinite(preset.cache_warming_minutes)
        ? Math.max(0, preset.cache_warming_minutes * 60_000)
        : 0,
    cacheWarmingMode: preset.cache_warming_mode === "prewarm" || preset.cache_warming_mode === "completion"
      ? preset.cache_warming_mode
      : "completion",
    cacheLifetimeMs,
    compactionStrategy,
    compactTriggerTokens,
    deepArchive,
    respectPromptCache: respectCache,
  }
}

/** Install the resolved primary model and all associated runtime settings. */
export function applyModelSwap(selection: ModelSwapSelection): void {
  modelState.primaryModel = selection.model
  modelState.primaryApiKey = selection.apiKey
  modelState.primaryToolChoice = selection.toolChoice
  modelState.useFallback = false
  setCodexFastMode(selection.fast)
  modelState.primaryVision = selection.vision
  modelState.primaryNudgeOnNoTool = selection.nudgeOnNoTool
  modelState.idleCompactionMs = selection.idleCompactionMs
  modelState.cacheWarming = selection.cacheWarming
  modelState.cacheWarmingDurationMs = selection.cacheWarmingDurationMs
  modelState.cacheWarmingMode = selection.cacheWarmingMode
  modelState.cacheLifetimeMs = selection.cacheLifetimeMs
  modelState.compactionStrategy = selection.compactionStrategy
  modelState.compactTriggerTokens = selection.compactTriggerTokens
  modelState.deepArchive = selection.deepArchive
  modelState.respectPromptCache = selection.respectPromptCache
  modelState.enableThinking = selection.enableThinking
  modelState.thinkingEffort = selection.thinkingEffort

  console.log(
    `[model-swap] swapped primary model to ${selection.model.id} ` +
      `(provider=${selection.model.provider}, base=${selection.model.baseUrl}, vision=${selection.vision})`,
  )
}

/** The selected preset persisted for restoration on the next process start. */
export let persistedModelPreset: string | undefined

/** Persist only the selected preset name; credentials and runtime config stay in their source files. */
export async function persistModelSwap(selection: ModelSwapSelection): Promise<void> {
  // Validate the durable name against the current config before committing it.
  resolveModelSwap(selection.preset)
  await atomicWriteFile(MODEL_SELECTION_PATH, `${JSON.stringify({ preset: selection.preset })}\n`, 0o600)
  persistedModelPreset = selection.preset
}

async function restorePersistedModelSwap(): Promise<void> {
  let contents: string
  try {
    contents = await fs.readFile(MODEL_SELECTION_PATH, "utf8")
  } catch (error) {
    if (isMissingFileError(error)) return
    throw new Error(`failed to read persisted model selection at ${MODEL_SELECTION_PATH}: ${String(error)}`, { cause: error })
  }

  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch (error) {
    throw new Error(`malformed persisted model selection at ${MODEL_SELECTION_PATH}: invalid JSON`, { cause: error })
  }
  if (!value || typeof value !== "object" || !("preset" in value) || typeof value.preset !== "string" || !value.preset.trim() || Object.keys(value).length !== 1) {
    throw new Error(`malformed persisted model selection at ${MODEL_SELECTION_PATH}: expected only a non-empty preset name`)
  }

  const preset = value.preset.trim()
  let selection: ModelSwapSelection
  try {
    selection = resolveModelSwap(preset)
  } catch (error) {
    throw new Error(`cannot restore persisted model preset "${preset}": ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  persistedModelPreset = preset
  applyModelSwap(selection)
}

// Ensure every first Context observes restored settings, including importers of this module.
await restorePersistedModelSwap()
