/**
 * Mutable runtime model state.
 *
 * The harness resolves model configuration (provider, api_key, thinking, etc.)
 * from TOML presets at startup. This module holds that resolved config in a
 * mutable singleton so it can be swapped at runtime via the model-swap feature.
 *
 * All code that makes LLM API calls reads from `modelState` rather than the
 * const exports in `config.ts`. This allows `POST /awp/swap-model` to swap
 * the primary model mid-session.
 */

import type { Model } from "../llm"
import { getModelPreset, type ToolChoice, type ThinkingEffort } from "../config"
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
  RESPECT_CACHE as initRespectCache,
  USE_FALLBACK as initUseFallback,
} from "./config"

export interface RuntimeModelConfig {
  // Primary model (swappable)
  primaryModel: Model | null
  primaryApiKey: string | undefined
  primaryToolChoice: ToolChoice
  primaryVision: boolean
  enableThinking: boolean
  thinkingEffort: ThinkingEffort

  // Fallback model (unchanged by swaps)
  fallbackModel: Model
  fallbackApiKey: string | undefined
  fallbackToolChoice: ToolChoice

  // Summary model (unchanged by swaps)
  summaryModel: Model | null
  summaryApiKey: string | undefined

  // Context behavior
  respectCache: boolean

  // Flags
  useFallback: boolean
}

// ── Initialization from config consts ───────────────────────────────────────

export const modelState: RuntimeModelConfig = {
  primaryModel: initPrimaryModel,
  primaryApiKey: initPrimaryKey,
  primaryToolChoice: initPrimaryToolChoice,
  primaryVision: initPrimaryVision,
  enableThinking: initEnableThinking,
  thinkingEffort: initThinkingEffort,

  fallbackModel: initFallbackModel,
  fallbackApiKey: initFallbackKey,
  fallbackToolChoice: initFallbackToolChoice,

  summaryModel: initSummaryModel,
  summaryApiKey: initSummaryKey,

  respectCache: initRespectCache,
  useFallback: initUseFallback,
}

// ── Swap logic ────────────────────────────────────────────────────────────────

export type SwapDecision =
  | {
      action: "swap"
      preset: string
      model: Model
      apiKey: string | undefined
      toolChoice: ToolChoice
      enableThinking: boolean
      thinkingEffort: ThinkingEffort
      vision: boolean
    }
  | { action: "rest"; preset: string; reason: string }

/**
 * Evaluates whether swapping to a named preset is compatible with the current
 * session context.
 *
 * Rest is triggered when:
 *   - The current session respects cache (model swap invalidates the prompt cache)
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
  )

  if (!model) {
    throw new Error(`failed to build model from preset "${presetName}"`)
  }

  // Compatibility check 1: if the current session respects cache, a model swap
  // invalidates the prompt cache (different tokenizer/prefix). Must rest.
  if (modelState.respectCache) {
    return {
      action: "rest",
      preset: presetName,
      reason: `current session respects cache - model swap to "${presetName}" invalidates prompt cache`,
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

  const thinkingEffort: ThinkingEffort =
    typeof preset.thinking_effort === "string" &&
    ["minimal", "low", "medium", "high", "xhigh"].includes(preset.thinking_effort as string)
      ? (preset.thinking_effort as ThinkingEffort)
      : modelState.thinkingEffort

  const vision =
    typeof preset.vision === "boolean" ? preset.vision : modelState.primaryVision

  return {
    action: "swap",
    preset: presetName,
    model,
    apiKey: apiKey || undefined,
    toolChoice,
    enableThinking,
    thinkingEffort,
    vision,
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
  modelState.primaryVision = decision.vision
  modelState.enableThinking = decision.enableThinking
  modelState.thinkingEffort = decision.thinkingEffort

  console.log(
    `[model-swap] swapped primary model to ${decision.model.id} ` +
      `(provider=${decision.model.provider}, base=${decision.model.baseUrl}, vision=${decision.vision})`,
  )
}
