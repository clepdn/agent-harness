import { config } from "@nano/runtime-api/config"

export const AGENT_NAME = config.agent.name
export const FALLBACK_N_CTX = config.fallback.n_ctx
export const FALLBACK_CONTEXT_MARGIN = config.fallback.context_margin
export const FALLBACK_HARD_OVERFLOW_TOKENS = config.fallback.hard_overflow_tokens
const fallbackBaseUrl = config.fallback.base_url.trim().toLowerCase()
const fallbackIsLocal = fallbackBaseUrl.includes("localhost") || fallbackBaseUrl.includes("127.0.0.1")
export const FALLBACK_ENFORCE_CONTEXT_LIMIT = config.fallback.enforce_context_limit ?? fallbackIsLocal

export const RESPECT_PROMPT_CACHE = config.model.respect_prompt_cache
export const COMPACTION_STRATEGY = config.model.compaction_strategy
export const DEEP_ARCHIVE_ENABLED = config.model.deep_archive
export const JOURNAL_BEFORE_COMPACTION = config.context.journal_before_compaction
export const REMOTE_COMPACTION_ENDPOINT = config.context.remote_compaction.endpoint
export const REMOTE_COMPACTION_MODEL = config.context.remote_compaction.model
export const REMOTE_COMPACTION_STREAMING_ENDPOINT = config.context.remote_compaction.streaming_endpoint
export const TOOL_RESULT_COMPACTION_MIN_AGE_TURNS = Math.max(1, config.context.tool_result_compaction_min_age_turns)
export const TOOL_RESULT_COMPACTION_MIN_CHARS = Math.max(100, config.context.tool_result_compaction_min_chars)
export const TOOL_RESULT_COMPACTION_MIN_CONTEXT_PERCENT = Math.min(100, Math.max(0, config.context.tool_result_compaction_min_context_percent))
export const CONTEXT_COMPACT_TRIGGER_TOKENS = config.model.compact_trigger_tokens

export function meetsToolResultCompactionContextThreshold(contextSize: number, contextWindow: number, minContextPercent: number): boolean {
  if (contextWindow <= 0) return false
  return contextSize / contextWindow * 100 >= minContextPercent
}

console.log(`[config] compaction_strategy=${COMPACTION_STRATEGY} trigger=${CONTEXT_COMPACT_TRIGGER_TOKENS} deep_archive=${DEEP_ARCHIVE_ENABLED} journal_first=${JOURNAL_BEFORE_COMPACTION}${REMOTE_COMPACTION_ENDPOINT ? ` remote=${REMOTE_COMPACTION_ENDPOINT}` : ""}`)
console.log(`[config] respect_prompt_cache=${RESPECT_PROMPT_CACHE} tool_result_compaction_min_age_turns=${TOOL_RESULT_COMPACTION_MIN_AGE_TURNS} tool_result_compaction_min_chars=${TOOL_RESULT_COMPACTION_MIN_CHARS} tool_result_compaction_min_context_percent=${TOOL_RESULT_COMPACTION_MIN_CONTEXT_PERCENT}`)
