/**
 * Anthropic (Claude subscription / OAuth) provider corner.
 *
 * Anthropic exposes a pollable account usage endpoint. Credentials are the
 * same OAuth access token the bridge already mints for anthropic-oauth models
 * (via the on-disk auth.json), so callers need no Anthropic key of their own.
 *
 * Endpoint + shape sourced from Claude Code:
 *   GET https://api.anthropic.com/api/oauth/usage
 *   headers: Authorization: Bearer <token>, anthropic-beta: oauth-2025-04-20
 */

import type { CustomProvider } from "./config"
import type { ProviderUsage } from "./usage"
import { createAnthropicStore } from "./anthropic-oauth"

const ANTHROPIC_BASE = "https://api.anthropic.com"
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20"

/** One rolling window from Anthropic's usage response. */
interface AnthropicRateLimit {
  utilization: number | null // percentage 0..100
  resets_at: string | null // ISO 8601
}

interface AnthropicUtilization {
  five_hour?: AnthropicRateLimit | null
  seven_day?: AnthropicRateLimit | null
  seven_day_opus?: AnthropicRateLimit | null
  seven_day_sonnet?: AnthropicRateLimit | null
  seven_day_oauth_apps?: AnthropicRateLimit | null
  extra_usage?: unknown
}

/**
 * Fetch and normalize Anthropic account usage. The five-hour window is the
 * primary signal; the seven-day window is appended to the display when present.
 * Returns null on any failure (no auth path, token error, non-ok, malformed).
 */
export async function fetchAnthropicUsage(provider: CustomProvider): Promise<ProviderUsage | null> {
  const authPath = provider.auth_path
  if (!authPath) return null

  try {
    const store = createAnthropicStore({ authPath })
    const token = await store.getAccessToken()

    const base = provider.base_url?.trim() ? provider.base_url.replace(/\/+$/, "") : ANTHROPIC_BASE
    const resp = await fetch(`${base}/api/oauth/usage`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": ANTHROPIC_OAUTH_BETA,
        "Content-Type": "application/json",
        "User-Agent": "nano-llm-bridge",
      },
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as AnthropicUtilization

    const primary = data.five_hour
    const util = primary?.utilization ?? 0
    const parts = [`5h ${Math.round(util)}%`]
    if (data.seven_day?.utilization != null) {
      parts.push(`7d ${Math.round(data.seven_day.utilization)}%`)
    }

    return {
      percent: util / 100,
      display: parts.join(" "),
      stats: data as Record<string, unknown>,
    }
  } catch {
    return null
  }
}
