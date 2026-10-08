import type { Model, ModelEffortCapabilities } from "@nano/runtime-api/llm"
import { config } from "@nano/runtime-api/config"
const useFallbackAtStartup = config.agent.env === "local"

export type { CompactionStrategy, ThinkingEffort, ToolChoice } from "@nano/runtime-api/config"

export const isLikelyLocalBase = (baseUrl: string): boolean => {
  const lowered = baseUrl.trim().toLowerCase()
  return lowered.includes("localhost") || lowered.includes("127.0.0.1")
}

// The default provider is a good fit for the common public OpenAI API. Other
// providers and local endpoints can supply their own base_url.
export const MODEL_PROVIDER = config.model.provider
export const MODEL = config.model.model
export const MODEL_BASE_URL = config.model.base_url
export const PRIMARY_VISION = config.model.vision
export const PRIMARY_NUDGE_ON_NO_TOOL = config.model.nudge_on_no_tool

export const FALLBACK_PROVIDER = config.fallback.provider
export const FALLBACK_MODEL = config.fallback.model
const FALLBACK_BASE_URL = config.fallback.base_url
export const FALLBACK_N_CTX = config.fallback.n_ctx
export const FALLBACK_CONTEXT_MARGIN = config.fallback.context_margin
export const FALLBACK_HARD_OVERFLOW_TOKENS = config.fallback.hard_overflow_tokens
export const FALLBACK_ENFORCE_CONTEXT_LIMIT = config.fallback.enforce_context_limit ?? isLikelyLocalBase(FALLBACK_BASE_URL)

export const SUMMARY_PROVIDER = config.summary.provider
export const SUMMARY_MODEL = config.summary.model

export const PRIMARY_TOOL_CHOICE = config.model.tool_choice
export const FALLBACK_TOOL_CHOICE = config.fallback.tool_choice
export const ENABLE_THINKING = config.model.enable_thinking
export const THINKING_EFFORT = config.model.thinking_effort

export function buildModel(
  provider: string,
  modelId: string,
  baseUrlOverride?: string,
  headers?: Record<string, string>,
  contextWindowOverride?: number,
  explicitlyBridge = false,
  _apiKey?: string,
  effortCapabilities?: ModelEffortCapabilities,
): Model | null {
  if (!modelId) return null

  const baseUrl = baseUrlOverride || (explicitlyBridge ? config.llm_bridge_url : "https://api.openai.com/v1")
  const resolvedProvider = provider || (isLikelyLocalBase(baseUrl) ? "lm-studio" : "openai")
  const bridge = explicitlyBridge || (!!config.llm_bridge_url &&
    baseUrl.replace(/\/+$/, "") === config.llm_bridge_url.replace(/\/+$/, ""))
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: resolvedProvider,
    baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextWindowOverride ?? 200_000,
    maxTokens: 8192,
    ...(bridge ? { bridge: true } : {}),
    ...(effortCapabilities ? { effortCapabilities } : {}),
    ...(headers && Object.keys(headers).length ? { headers } : {}),
  }
}

if (!useFallbackAtStartup && !MODEL) {
  throw new Error('[model].model is required unless the fallback is forced ([agent].env = "local").')
}
if (!useFallbackAtStartup && !MODEL_PROVIDER && !MODEL_BASE_URL) {
  throw new Error('[model].provider or [model].base_url is required. Example: [model] provider = "openrouter"')
}
if (!useFallbackAtStartup && !config.model.api_key) {
  throw new Error("[model].api_key is required. Place it in the secrets file.")
}

console.log(`[config] thinking=${ENABLE_THINKING}`)
