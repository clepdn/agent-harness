import type { Model, ModelEffortCapabilities } from "../llm"
import { config } from "../config"
import { idleCacheCompactionMs } from "../cache-policy"

// ── Misc thresholds ───────────────────────────────────────────────────────────

// These values are fixed parsed configuration thresholds. Mutable per-model
// settings are owned by the model plugin's generation-scoped state resource.
export const RESPECT_PROMPT_CACHE = config.model.respect_prompt_cache
export const COMPACTION_STRATEGY = config.model.compaction_strategy
export const DEEP_ARCHIVE_ENABLED = config.model.deep_archive
export const JOURNAL_BEFORE_COMPACTION = config.context.journal_before_compaction
export const REMOTE_COMPACTION_ENDPOINT = config.context.remote_compaction.endpoint
export const REMOTE_COMPACTION_MODEL = config.context.remote_compaction.model
export const REMOTE_COMPACTION_STREAMING_ENDPOINT = config.context.remote_compaction.streaming_endpoint
export const TOOL_RESULT_COMPACTION_MIN_AGE_TURNS = Math.max(1, config.context.tool_result_compaction_min_age_turns)
export const TOOL_RESULT_COMPACTION_MIN_CHARS = Math.max(100, config.context.tool_result_compaction_min_chars)
export const TOOL_RESULT_COMPACTION_MIN_CONTEXT_PERCENT = Math.min(
  100,
  Math.max(0, config.context.tool_result_compaction_min_context_percent),
)

// Primary-model compaction threshold is parsed alongside the primary model config.
export const CONTEXT_COMPACT_TRIGGER_TOKENS = config.model.compact_trigger_tokens


export function meetsToolResultCompactionContextThreshold(
  contextSize: number,
  contextWindow: number,
  minContextPercent: number,
): boolean {
  if (contextWindow <= 0) return false
  return contextSize / contextWindow * 100 >= minContextPercent
}

/**
 * Cache-respecting idle compaction runs three minutes before cache expiry.
 * Warming takes over this timing when enabled. Preset swaps recalculate it.
 */
export const PRIMARY_IDLE_COMPACTION_MS = idleCacheCompactionMs(
  config.model.cache_lifetime_minutes * 60_000,
  config.model.respect_prompt_cache,
  config.model.cache_warming,
)

export const USE_FALLBACK = config.agent.env === "local"

/** Display name for the agent, used in the summarizer prompt and grounding. */
export const AGENT_NAME = config.agent.name

/** Boredom wake: if > 0, wake the agent after this many minutes of inactivity. */
export const BOREDOM_WAKE_MS = (() => {
  const minutes = config.agent.boredom_wake_min
  if (!Number.isFinite(minutes) || minutes <= 0) return 0
  return Math.round(minutes * 60_000)
})()

/** When true, checks git upstream on every file read/write and nags if changed. */
export const GIT_UPSTREAM_NAG = config.agent.git_upstream_nag

// ── Helpers ───────────────────────────────────────────────────────────────────

export const isLikelyLocalBase = (baseUrl: string): boolean => {
  const lowered = baseUrl.trim().toLowerCase()
  return lowered.includes("localhost") || lowered.includes("127.0.0.1")
}

// ── Primary model ─────────────────────────────────────────────────────────────
// model.provider + model.model resolve the endpoint. base_url is required for
// non-OpenAI providers (OpenRouter, local LLMs, etc.).
//
//   [model] provider = "openrouter"  model = "deepseek/deepseek-r1"
//   [model] provider = "openai"      model = "gpt-4o"
//
// Escape hatch for unlisted/custom endpoints: set [model].base_url.
export const MODEL_PROVIDER = config.model.provider
export const MODEL = config.model.model
export const MODEL_BASE_URL = config.model.base_url
export const PRIMARY_VISION = config.model.vision
export const PRIMARY_NUDGE_ON_NO_TOOL = config.model.nudge_on_no_tool

// ── Fallback model ────────────────────────────────────────────────────────────
export const FALLBACK_PROVIDER = config.fallback.provider
export const FALLBACK_MODEL = config.fallback.model
const FALLBACK_BASE_URL = config.fallback.base_url
export const FALLBACK_N_CTX = config.fallback.n_ctx
export const FALLBACK_CONTEXT_MARGIN = config.fallback.context_margin
export const FALLBACK_HARD_OVERFLOW_TOKENS = config.fallback.hard_overflow_tokens
export const FALLBACK_ENFORCE_CONTEXT_LIMIT = config.fallback.enforce_context_limit ?? isLikelyLocalBase(FALLBACK_BASE_URL)

// ── Summary model ─────────────────────────────────────────────────────────────
export const SUMMARY_PROVIDER = config.summary.provider
export const SUMMARY_MODEL = config.summary.model

// ── Tool choice ───────────────────────────────────────────────────────────────
export const PRIMARY_TOOL_CHOICE = config.model.tool_choice
export const FALLBACK_TOOL_CHOICE = config.fallback.tool_choice

// ── Thinking ──────────────────────────────────────────────────────────────────
export const ENABLE_THINKING = config.model.enable_thinking
export const THINKING_EFFORT = config.model.thinking_effort

// ── Model construction ────────────────────────────────────────────────────────

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

// Model instances and credentials are owned by the model plugin generation.
// ── Startup validation ────────────────────────────────────────────────────────
if (!USE_FALLBACK && !MODEL) {
  throw new Error("[model].model is required unless the fallback is forced ([agent].env = \"local\").")
}
if (!USE_FALLBACK && !MODEL_PROVIDER && !MODEL_BASE_URL) {
  throw new Error("[model].provider or [model].base_url is required. Example: [model] provider = \"openrouter\"")
}
if (!USE_FALLBACK && !config.model.api_key) {
  throw new Error("[model].api_key is required. Place it in the secrets file.")
}

console.log(`[config] env=${config.agent.env} use_fallback=${USE_FALLBACK}`)
console.log(`[config] thinking=${ENABLE_THINKING}`)
if (PRIMARY_IDLE_COMPACTION_MS > 0) console.log(`[config] idle_compaction=${PRIMARY_IDLE_COMPACTION_MS / 60_000}min`)
console.log(
  `[config] compaction_strategy=${COMPACTION_STRATEGY} trigger=${CONTEXT_COMPACT_TRIGGER_TOKENS} deep_archive=${DEEP_ARCHIVE_ENABLED} journal_first=${JOURNAL_BEFORE_COMPACTION}` +
    (REMOTE_COMPACTION_ENDPOINT ? ` remote=${REMOTE_COMPACTION_ENDPOINT}` : ""),
)
console.log(
  `[config] respect_prompt_cache=${RESPECT_PROMPT_CACHE} tool_result_compaction_min_age_turns=${TOOL_RESULT_COMPACTION_MIN_AGE_TURNS} tool_result_compaction_min_chars=${TOOL_RESULT_COMPACTION_MIN_CHARS} tool_result_compaction_min_context_percent=${TOOL_RESULT_COMPACTION_MIN_CONTEXT_PERCENT}`,
)
