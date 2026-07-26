/**
 * umans provider corner.
 *
 * umans is otherwise a plain OpenAI-compatible provider, but it has two
 * quirks the bridge owns here:
 *   - an account-level usage endpoint (`GET /v1/usage`) reporting a rolling
 *     request-count window against a hard cap, normalized into a ProviderUsage;
 *   - a hard per-request limit on how many images a single completion may
 *     carry, enforced by trimming the request before it goes upstream.
 */

import type { CustomProvider } from "./config"
import type { ProviderUsage } from "./usage"
import type { OaiContentPart, OaiMessage } from "./translate"

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

// ── Image cap ─────────────────────────────────────────────────────────────────

/**
 * Most images umans accepts in a single completion request. Anything above
 * this and the upstream rejects the whole request, so the bridge trims instead.
 */
export const UMANS_MAX_IMAGES = 10

/** Does this model route to umans? Provider key first, endpoint host as backstop. */
export function isUmansModel(model: { provider: string; baseUrl?: string }): boolean {
  if (model.provider === "umans") return true
  if (!model.baseUrl) return false
  let host: string
  try {
    host = new URL(model.baseUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  return host === "umans.ai" || host.endsWith(".umans.ai")
}

function countImages(content: OaiContentPart[]): number {
  let n = 0
  for (const part of content) if (part?.type === "image_url") n++
  return n
}

/**
 * Keep only the last `max` images in an OpenAI-format request; older image
 * parts are cut out entirely. A message left with no content (a screenshot-only
 * user turn, which is how tool-result images arrive) is dropped too, since an
 * empty content array is itself a 400.
 *
 * The input array is returned untouched when it is already under the cap, and
 * only the messages that actually lose an image are rebuilt.
 */
export function capImagesForUmans(
  messages: OaiMessage[],
  max: number = UMANS_MAX_IMAGES,
): { messages: OaiMessage[]; dropped: number } {
  let total = 0
  for (const msg of messages) {
    if (Array.isArray(msg.content)) total += countImages(msg.content)
  }
  if (total <= max) return { messages, dropped: 0 }

  // Walk backwards so the survivors are the most recent images.
  let budget = max
  const kept: OaiMessage[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (!Array.isArray(msg.content)) {
      kept.push(msg)
      continue
    }
    const images = countImages(msg.content)
    if (images <= budget) {
      budget -= images
      kept.push(msg)
      continue
    }

    const content: OaiContentPart[] = []
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const part = msg.content[j]!
      if (part.type === "image_url") {
        if (budget === 0) continue
        budget--
      }
      content.push(part)
    }
    content.reverse()
    if (content.length > 0) kept.push({ ...msg, content })
  }
  kept.reverse()

  return { messages: kept, dropped: total - max }
}
