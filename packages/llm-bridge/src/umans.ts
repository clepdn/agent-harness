/**
 * umans provider corner.
 *
 * umans is otherwise a plain OpenAI-compatible provider, but it exposes an
 * account-level usage endpoint (`GET /v1/usage`) reporting a rolling
 * request-count window against a hard cap. This module owns that
 * umans-specific behavior and normalizes it into a ProviderUsage.
 */

import type { CustomProvider } from "./config"
import type { ProviderUsage } from "./usage"

/** Subset of umans' GET /v1/usage response that we consume. */
interface UmansUsageResponse {
  usage?: { requests_in_window?: number }
  limits?: { requests?: { hard_cap?: number } }
}

/**
 * Fetch and normalize umans account usage.
 *
 * Uses the provider's own credential (server-side), so callers never need a
 * umans key. Returns null on any failure (network, auth, malformed body) so
 * the caller can degrade gracefully.
 */
export async function fetchUmansUsage(provider: CustomProvider): Promise<ProviderUsage | null> {
  const base = provider.base_url?.replace(/\/+$/, "")
  const apiKey = provider.api_key
  if (!base || !apiKey) return null

  try {
    const resp = await fetch(`${base}/usage`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as UmansUsageResponse

    const used = data.usage?.requests_in_window ?? 0
    const cap = data.limits?.requests?.hard_cap ?? 0
    const percent = cap > 0 ? used / cap : 0

    return {
      percent,
      display: cap > 0 ? `${used}/${cap}` : `${used}`,
      stats: data as Record<string, unknown>,
    }
  } catch {
    return null
  }
}
