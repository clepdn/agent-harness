/**
 * Codex (ChatGPT plan) usage — push model.
 *
 * Codex has no pollable usage endpoint. Rate-limit state only arrives on the
 * `x-codex-*` response headers of actual `/responses` completions (see
 * codex-rs/codex-api/src/rate_limits.rs). So the bridge records the latest
 * snapshot every time a codex completion passes through, and serves it cached.
 *
 * Consequence: usage is unavailable until the first codex completion flows
 * through after startup. That's intentional — the alternative (firing a
 * throwaway request to read headers) would burn quota to measure quota.
 */

import type { ProviderUsage } from "./usage"

interface CodexWindow {
  used_percent: number // 0..100
  window_minutes?: number
  reset_at?: number // unix seconds
}

interface CodexSnapshot {
  primary?: CodexWindow
  secondary?: CodexWindow
  fetchedAt: number
}

// Keyed by provider name (e.g. "codex"). Latest snapshot wins.
const cache = new Map<string, CodexSnapshot>()

function headerNum(headers: Record<string, string>, name: string): number | undefined {
  const raw = headers[name.toLowerCase()]
  if (raw == null) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

function parseWindow(headers: Record<string, string>, prefix: string): CodexWindow | undefined {
  const used = headerNum(headers, `${prefix}-used-percent`)
  if (used == null) return undefined
  return {
    used_percent: used,
    window_minutes: headerNum(headers, `${prefix}-window-minutes`),
    reset_at: headerNum(headers, `${prefix}-reset-at`),
  }
}

/**
 * Record the latest codex rate-limit snapshot from a completion's `x-codex-*`
 * response headers. No-op when the headers carry no rate-limit data.
 */
export function recordCodexUsage(providerName: string, headers: Record<string, string>): void {
  const primary = parseWindow(headers, "x-codex-primary")
  const secondary = parseWindow(headers, "x-codex-secondary")
  if (!primary && !secondary) return
  cache.set(providerName, { primary, secondary, fetchedAt: Date.now() })
}

function windowLabel(minutes?: number): string {
  if (!minutes || minutes <= 0) return ""
  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

/**
 * Serve the cached codex usage snapshot. Returns null until a completion has
 * populated the cache. Annotates staleness in `stats.age_ms`.
 */
export function getCachedCodexUsage(providerName: string): ProviderUsage | null {
  const snap = cache.get(providerName)
  if (!snap) return null
  const win = snap.primary ?? snap.secondary
  if (!win) return null

  const label = windowLabel(win.window_minutes)
  const pct = Math.round(win.used_percent)
  return {
    percent: win.used_percent / 100,
    display: label ? `${label} ${pct}%` : `${pct}%`,
    stats: {
      primary: snap.primary,
      secondary: snap.secondary,
      fetched_at: snap.fetchedAt,
      age_ms: Date.now() - snap.fetchedAt,
    },
  }
}

/** Test hook: clear the in-memory cache. */
export function __clearCodexUsageCache(): void {
  cache.clear()
}
