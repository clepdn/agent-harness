import { getEnvApiKey, getModel as piGetModel, getModels as piGetModels } from "@earendil-works/pi-ai"
import type { KnownProvider, Model } from "@earendil-works/pi-ai"

// ── Misc thresholds ───────────────────────────────────────────────────────────

export const TOKEN_NUDGE_THRESHOLD = parseInt(process.env.TOKEN_NUDGE_THRESHOLD ?? "120000")
export const FALLBACK_TOKEN_NUDGE_THRESHOLD = parseInt(process.env.FALLBACK_TOKEN_NUDGE_THRESHOLD ?? "50000")
export const CONTEXT_COMPACT_TRIGGER_TOKENS = parseInt(process.env.CONTEXT_COMPACT_TRIGGER_TOKENS ?? "90000")

const NIRI_ENV = (process.env.NIRI_ENV ?? "default").trim().toLowerCase()
export const USE_FALLBACK = NIRI_ENV === "local"

/** Display name for the agent, used in the summarizer prompt and grounding. */
export const AGENT_NAME = (process.env.AGENT_NAME ?? "").trim() || "niri"

// ── Helpers ───────────────────────────────────────────────────────────────────

export const parseBooleanEnv = (value: string | undefined, fallback: boolean): boolean => {
  if (typeof value !== "string") return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false
  return fallback
}

export const isLikelyLocalBase = (baseUrl: string): boolean => {
  const lowered = baseUrl.trim().toLowerCase()
  return lowered.includes("localhost") || lowered.includes("127.0.0.1")
}

const parseToolChoiceEnv = (value: string | undefined, fallback: "required" | "auto" | "none"): "required" | "auto" | "none" => {
  if (typeof value !== "string") return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === "required" || normalized === "auto" || normalized === "none") return normalized
  return fallback
}

// ── Primary model ─────────────────────────────────────────────────────────────
// Preferred: MODEL_PROVIDER + MODEL (uses pi's registry for base URL, compat,
// reasoning flags, and env key lookup — unambiguous across providers).
//
//   MODEL_PROVIDER=openrouter   MODEL=deepseek/deepseek-r1  → OPENROUTER_API_KEY
//   MODEL_PROVIDER=deepseek     MODEL=deepseek-v4-pro        → DEEPSEEK_API_KEY
//   MODEL_PROVIDER=openai       MODEL=gpt-4o                 → OPENAI_API_KEY
//
// Escape hatch for unlisted/custom endpoints: set MODEL_BASE_URL.
export const MODEL_PROVIDER = (process.env.MODEL_PROVIDER ?? "").trim()
export const MODEL = (process.env.MODEL ?? "").trim()
const MODEL_BASE_URL = (process.env.MODEL_BASE_URL ?? "").trim()

// ── Fallback model ────────────────────────────────────────────────────────────
export const FALLBACK_PROVIDER = (process.env.FALLBACK_PROVIDER ?? "").trim()
export const FALLBACK_MODEL = (process.env.FALLBACK_MODEL || "zai-org/glm-4.7-flash").trim()
const FALLBACK_BASE_URL = (process.env.FALLBACK_BASE_URL ?? process.env.FALLBACK_OPENAI_BASE_URL ?? "").trim()
export const FALLBACK_N_CTX = parseInt(process.env.FALLBACK_N_CTX ?? "4096")
export const FALLBACK_CONTEXT_MARGIN = parseInt(process.env.FALLBACK_CONTEXT_MARGIN ?? "256")
export const FALLBACK_HARD_OVERFLOW_TOKENS = parseInt(process.env.FALLBACK_HARD_OVERFLOW_TOKENS ?? "1024")
export const FALLBACK_ENFORCE_CONTEXT_LIMIT = parseBooleanEnv(process.env.FALLBACK_ENFORCE_CONTEXT_LIMIT, isLikelyLocalBase(FALLBACK_BASE_URL))

// ── Summary model ─────────────────────────────────────────────────────────────
export const SUMMARY_PROVIDER = (process.env.SUMMARY_PROVIDER ?? "").trim()
export const SUMMARY_MODEL = (process.env.SUMMARY_MODEL || "").trim()
const SUMMARY_BASE_URL = (process.env.SUMMARY_BASE_URL ?? process.env.SUMMARY_OPENAI_BASE_URL ?? "").trim()

// ── Tool choice ───────────────────────────────────────────────────────────────
export const PRIMARY_TOOL_CHOICE = parseToolChoiceEnv(process.env.PRIMARY_TOOL_CHOICE ?? process.env.TOOL_CHOICE, "required")
export const FALLBACK_TOOL_CHOICE = parseToolChoiceEnv(process.env.FALLBACK_TOOL_CHOICE, "required")

// ── Thinking ──────────────────────────────────────────────────────────────────
export const ENABLE_THINKING = parseBooleanEnv(process.env.ENABLE_THINKING, true)
export const THINKING_EFFORT = (() => {
  const v = (process.env.THINKING_EFFORT ?? "low").trim().toLowerCase()
  return (["minimal", "low", "medium", "high", "xhigh"].includes(v) ? v : "low") as "minimal" | "low" | "medium" | "high" | "xhigh"
})()

// ── Extra headers ─────────────────────────────────────────────────────────────
const fallbackHeaders: Record<string, string> = {}
if (process.env.FALLBACK_OPENAI_REFERER) fallbackHeaders["HTTP-Referer"] = process.env.FALLBACK_OPENAI_REFERER
if (process.env.FALLBACK_OPENAI_TITLE) fallbackHeaders["X-Title"] = process.env.FALLBACK_OPENAI_TITLE
const summaryHeaders: Record<string, string> = {}
if (process.env.SUMMARY_OPENAI_REFERER) summaryHeaders["HTTP-Referer"] = process.env.SUMMARY_OPENAI_REFERER
if (process.env.SUMMARY_OPENAI_TITLE) summaryHeaders["X-Title"] = process.env.SUMMARY_OPENAI_TITLE

// ── Model construction ────────────────────────────────────────────────────────

function lookupRegisteredModel(provider: string, modelId: string): Model<"openai-completions"> | undefined {
  if (!provider || !modelId) return undefined
  // @ts-expect-error — runtime lookup; returns undefined for unregistered combinations
  return piGetModel(provider as KnownProvider, modelId) as Model<"openai-completions"> | undefined
}

function providerBaseUrl(provider: string): string | undefined {
  const models = piGetModels(provider as KnownProvider)
  return models[0]?.baseUrl
}

function buildModel(
  provider: string,
  modelId: string,
  baseUrlOverride?: string,
  headers?: Record<string, string>,
  contextWindowOverride?: number,
): Model<"openai-completions"> | null {
  if (!modelId) return null

  const registered = lookupRegisteredModel(provider, modelId)
  if (registered && !baseUrlOverride) {
    return headers && Object.keys(headers).length ? { ...registered, headers } : registered
  }

  const baseUrl = baseUrlOverride || providerBaseUrl(provider) || "https://api.openai.com/v1"
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
export const API_BASE = MODEL_BASE_URL || providerBaseUrl(MODEL_PROVIDER) || "(unknown)"
export const FALLBACK_BASE = FALLBACK_BASE_URL
export const SUMMARY_BASE = SUMMARY_BASE_URL

// ── Startup validation ────────────────────────────────────────────────────────
if (!USE_FALLBACK && !MODEL) {
  throw new Error("MODEL is required unless fallback is forced (NIRI_ENV=local).")
}
if (!USE_FALLBACK && !MODEL_PROVIDER && !MODEL_BASE_URL) {
  throw new Error("MODEL_PROVIDER or MODEL_BASE_URL is required. Example: MODEL_PROVIDER=openrouter")
}
if (!USE_FALLBACK) {
  const builtModel = buildModel(MODEL_PROVIDER, MODEL, MODEL_BASE_URL || undefined)
  if (!builtModel) throw new Error("Failed to construct primary model. Check MODEL and MODEL_PROVIDER.")
  const key = getEnvApiKey(builtModel.provider)
  if (!key) throw new Error(
    `No API key found for provider "${builtModel.provider}". Set the standard key (e.g. OPENROUTER_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY).`,
  )
}

export const primaryModel: Model<"openai-completions"> | null = USE_FALLBACK
  ? null
  : buildModel(MODEL_PROVIDER, MODEL, MODEL_BASE_URL || undefined)!

export const fallbackModel: Model<"openai-completions"> = (
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

export const summaryModel: Model<"openai-completions"> | null =
  SUMMARY_MODEL
    ? buildModel(SUMMARY_PROVIDER, SUMMARY_MODEL, SUMMARY_BASE_URL || undefined, Object.keys(summaryHeaders).length ? summaryHeaders : undefined) ?? null
    : null

// Explicit key overrides — only needed when the provider's standard env var doesn't apply
export const PRIMARY_API_KEY: string | undefined = process.env.MODEL_API_KEY
export const FALLBACK_API_KEY: string | undefined = process.env.FALLBACK_API_KEY
export const SUMMARY_API_KEY: string | undefined = process.env.SUMMARY_API_KEY

console.log(`[config] primary=${MODEL} provider=${primaryModel?.provider ?? "none"} @ ${primaryModel?.baseUrl ?? "none"}`)
console.log(`[config] fallback=${FALLBACK_MODEL} provider=${fallbackModel.provider} @ ${fallbackModel.baseUrl}`)
if (summaryModel) console.log(`[config] summary=${SUMMARY_MODEL} provider=${summaryModel.provider} @ ${summaryModel.baseUrl}`)
console.log(`[config] env=${NIRI_ENV} use_fallback=${USE_FALLBACK}`)
console.log(`[config] thinking=${ENABLE_THINKING}`)
