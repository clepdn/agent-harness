import type { Model } from "../llm"
import { config } from "../config"

// ── Misc thresholds ───────────────────────────────────────────────────────────

export const CONTEXT_COMPACT_TRIGGER_TOKENS = config.context.compact_trigger_tokens
export const PRESERVE_PROMPT_CACHE = config.context.preserve_prompt_cache
export const TOOL_RESULT_COMPACTION_MIN_AGE_TURNS = Math.max(1, config.context.tool_result_compaction_min_age_turns)
export const TOOL_RESULT_COMPACTION_MIN_CHARS = Math.max(100, config.context.tool_result_compaction_min_chars)
export const TOOL_RESULT_COMPACTION_MIN_CONTEXT_PERCENT = Math.min(
  100,
  Math.max(0, config.context.tool_result_compaction_min_context_percent),
)

export function meetsToolResultCompactionContextThreshold(
  contextSize: number,
  contextWindow: number,
  minContextPercent: number,
): boolean {
  if (contextWindow <= 0) return false
  return contextSize / contextWindow * 100 >= minContextPercent
}

export const IDLE_COMPACTION_TIMEOUT_MS = (() => {
  const minutes = config.context.idle_compaction_minutes
  if (!Number.isFinite(minutes) || minutes <= 0) return 0
  return Math.round(minutes * 60_000)
})()

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
const SUMMARY_BASE_URL = config.summary.base_url

// ── Tool choice ───────────────────────────────────────────────────────────────
export const PRIMARY_TOOL_CHOICE = config.model.tool_choice
export const FALLBACK_TOOL_CHOICE = config.fallback.tool_choice

// ── Thinking ──────────────────────────────────────────────────────────────────
export const ENABLE_THINKING = config.model.enable_thinking
export const THINKING_EFFORT = config.model.thinking_effort
export const PRIMARY_VISION = config.model.vision
export const PRIMARY_NUDGE_ON_NO_TOOL = config.model.nudge_on_no_tool

// ── Extra headers ─────────────────────────────────────────────────────────────
const fallbackHeaders: Record<string, string> = {}
if (config.fallback.referer) fallbackHeaders["HTTP-Referer"] = config.fallback.referer
if (config.fallback.title) fallbackHeaders["X-Title"] = config.fallback.title
const summaryHeaders: Record<string, string> = {}
if (config.summary.referer) summaryHeaders["HTTP-Referer"] = config.summary.referer
if (config.summary.title) summaryHeaders["X-Title"] = config.summary.title

// ── Model construction ────────────────────────────────────────────────────────

export function buildModel(
  provider: string,
  modelId: string,
  baseUrlOverride?: string,
  headers?: Record<string, string>,
  contextWindowOverride?: number,
): Model | null {
  if (!modelId) return null

  const baseUrl = baseUrlOverride || "https://api.openai.com/v1"
  const resolvedProvider = provider || (isLikelyLocalBase(baseUrl) ? "lm-studio" : "openai")
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
    ...(headers && Object.keys(headers).length ? { headers } : {}),
  }
}

// Backwards-compat exports for code that references these directly
// Backwards-compat exports for code that references these directly
export const API_BASE = MODEL_BASE_URL || "(unknown)"
export const FALLBACK_BASE = FALLBACK_BASE_URL
export const SUMMARY_BASE = SUMMARY_BASE_URL

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

export const primaryModel: Model | null = USE_FALLBACK
  ? null
  : buildModel(MODEL_PROVIDER, MODEL, MODEL_BASE_URL || undefined)!

export const fallbackModel: Model = (
  buildModel(
    FALLBACK_PROVIDER,
    FALLBACK_MODEL,
    FALLBACK_BASE_URL || undefined,
    Object.keys(fallbackHeaders).length ? fallbackHeaders : undefined,
    FALLBACK_BASE_URL ? FALLBACK_N_CTX : undefined,
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
)

export const summaryModel: Model | null =
  SUMMARY_MODEL
    ? buildModel(SUMMARY_PROVIDER, SUMMARY_MODEL, SUMMARY_BASE_URL || undefined, Object.keys(summaryHeaders).length ? summaryHeaders : undefined) ?? null
    : null

// API keys come from the secrets TOML. Empty string means "not configured" and
// is treated as undefined so callers fall through to their no-key paths.
export const PRIMARY_API_KEY: string | undefined = config.model.api_key || undefined
export const FALLBACK_API_KEY: string | undefined = config.fallback.api_key || undefined
export const SUMMARY_API_KEY: string | undefined = config.summary.api_key || undefined

console.log(`[config] primary=${MODEL} provider=${primaryModel?.provider ?? "none"} @ ${primaryModel?.baseUrl ?? "none"}`)
console.log(`[config] fallback=${FALLBACK_MODEL} provider=${fallbackModel.provider} @ ${fallbackModel.baseUrl}`)
if (summaryModel) console.log(`[config] summary=${SUMMARY_MODEL} provider=${summaryModel.provider} @ ${summaryModel.baseUrl}`)
console.log(`[config] env=${config.agent.env} use_fallback=${USE_FALLBACK}`)
console.log(`[config] thinking=${ENABLE_THINKING}`)
if (IDLE_COMPACTION_TIMEOUT_MS > 0) console.log(`[config] idle_compaction=${IDLE_COMPACTION_TIMEOUT_MS / 60_000}min`)
console.log(
  `[config] preserve_prompt_cache=${PRESERVE_PROMPT_CACHE} tool_result_compaction_min_age_turns=${TOOL_RESULT_COMPACTION_MIN_AGE_TURNS} tool_result_compaction_min_chars=${TOOL_RESULT_COMPACTION_MIN_CHARS} tool_result_compaction_min_context_percent=${TOOL_RESULT_COMPACTION_MIN_CONTEXT_PERCENT}`,
)
