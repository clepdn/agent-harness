/**
 * Provider usage capability.
 *
 * A provider-agnostic view of "how much of my budget have I burned",
 * surfaced to clients via `GET /v1/usage?model=<id>`. Each provider that
 * has an account/rate-limit concept implements a fetcher; the endpoint
 * resolves a model to its backing provider and delegates.
 *
 * Only providers listed in USAGE_PROVIDERS are implemented. Others resolve
 * but report unsupported, so clients can degrade gracefully.
 */

import type { BridgeConfig, CustomProvider } from "./config"
import { fetchUmansUsage } from "./umans"
import { fetchAnthropicUsage } from "./anthropic"
import { getCachedCodexUsage } from "./codex-usage"

/** Normalized usage snapshot returned by /v1/usage. */
export interface ProviderUsage {
  /** Fraction of the provider's budget consumed, 0.0–1.0. */
  percent: number
  /** Short, provider-custom string for display (e.g. "123/400"). */
  display: string
  /** Raw provider payload, for debugging / future dashboards. */
  stats: Record<string, unknown>
}

/** Providers with a usage fetcher implemented today. */
const USAGE_PROVIDERS: Record<string, true> = {
  umans: true, // pull: GET /v1/usage
  "anthropic-oauth": true, // pull: GET /api/oauth/usage
  codex: true, // push: cached from x-codex-* completion headers
  // TODO: antigravity (closed binary — intentionally skipped).
}

/**
 * Resolve which provider backs a given model id. Mirrors the routing order in
 * server.ts: name-prefix providers first, then the discovered registry.
 */
export function resolveProviderName(config: BridgeConfig, modelId: string): string | null {
  const lower = modelId.toLowerCase()
  if (lower.startsWith("gemini-") || lower.startsWith("agy-")) return "antigravity"
  if (
    lower.startsWith("gpt-") ||
    lower.startsWith("o3-") ||
    lower.startsWith("o4-") ||
    lower.startsWith("codex-")
  ) {
    return "codex"
  }
  return config.models[modelId]?.provider ?? null
}

/** Whether a resolved provider has a usage fetcher implemented. */
export function hasUsageSupport(providerName: string): boolean {
  return USAGE_PROVIDERS[providerName] === true
}

/**
 * Fetch normalized usage for the provider backing `modelId`.
 * Returns null when the provider is unconfigured, unsupported, has no cached
 * data yet (codex), or the fetch itself failed — the endpoint distinguishes.
 */
export async function getUsageForModel(
  config: BridgeConfig,
  providerName: string,
  modelId: string,
): Promise<ProviderUsage | null> {
  switch (providerName) {
    case "umans": {
      const provider = config.providers[providerName]
      return provider ? fetchUmansUsage(provider) : null
    }
    case "anthropic-oauth": {
      // Anthropic models are labeled "anthropic-oauth" regardless of the
      // provider's config key, so derive the credential from the per-model
      // authPath (falling back to any provider carrying an auth_path).
      const model = config.models[modelId]
      const provider: CustomProvider | undefined = model?.authPath
        ? { auth_path: model.authPath, base_url: model.baseUrl }
        : Object.values(config.providers).find((p) => p.auth_path)
      return provider ? fetchAnthropicUsage(provider) : null
    }
    case "codex":
      return getCachedCodexUsage(providerName)
    default:
      return null
  }
}
