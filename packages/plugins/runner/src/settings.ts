import { config } from "@nano/runtime-api/config"
import { idleCacheCompactionMs } from "@nano/runtime-api/cache-policy"

export const USE_FALLBACK = config.agent.env === "local"
export const BOREDOM_WAKE_MS = (() => {
  const minutes = config.agent.boredom_wake_min
  if (!Number.isFinite(minutes) || minutes <= 0) return 0
  return Math.round(minutes * 60_000)
})()
export const PRIMARY_IDLE_COMPACTION_MS = idleCacheCompactionMs(
  config.model.cache_lifetime_minutes * 60_000,
  config.model.respect_prompt_cache,
  config.model.cache_warming,
)

console.log(`[config] env=${config.agent.env} use_fallback=${USE_FALLBACK}`)
if (PRIMARY_IDLE_COMPACTION_MS > 0) console.log(`[config] idle_compaction=${PRIMARY_IDLE_COMPACTION_MS / 60_000}min`)
