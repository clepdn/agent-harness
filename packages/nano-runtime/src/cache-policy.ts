/** Cache timing shared by startup, frontend presets, live swaps, and warming. */
export function cacheLifetimeMinutes(source: Record<string, unknown>): number {
  const value = source.cache_lifetime_minutes ?? source.idle_compaction_minutes ?? 30
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 30
}

export function respectPromptCache(source: Record<string, unknown>, fallback = true): boolean {
  const value = source.respect_prompt_cache ?? source.preserve_prompt_cache
  return typeof value === "boolean" ? value : source.idle_compaction_minutes !== undefined ? true : fallback
}

/** Leave three minutes for the request/compaction to finish before expiry. */
export function cacheRefreshIntervalMs(lifetimeMs: number): number {
  return Number.isFinite(lifetimeMs) ? Math.max(0, lifetimeMs - 3 * 60_000) : 0
}

export function idleCacheCompactionMs(lifetimeMs: number, respectCache: boolean, warming: boolean): number {
  // Warming either runs indefinitely or has its own rounded compaction budget.
  return respectCache && !warming ? Math.round(cacheRefreshIntervalMs(lifetimeMs)) : 0
}
