/**
 * Discord status updater — periodically sets the bot's custom activity
 * to show context usage and provider budget usage.
 *
 * Provider usage comes from the remote endpoint's /v1/usage API (the
 * bridge holds the provider credential), so nano needs only its bridge
 * client key. The bridge returns a provider-custom `display` string.
 *
 * Format (model info available):  "x% [123/400]"
 * Format (model info unavailable): "205K [123/400]"
 * Format (no provider usage):      "x%"
 */

import type { Client } from "discord.js"

const STATUS_INTERVAL_MS = 60_000

/** Normalized usage payload from the bridge's GET /v1/usage. */
interface BridgeUsage {
  available: boolean
  provider?: string
  percent?: number
  display?: string
  stats?: Record<string, unknown>
}

interface BridgeModel {
  id: string
  context_length?: number
}

export interface DiscordStatusUpdaterConfig {
  model: {
    api_key: string
    base_url: string
    model: string
  }
}

export interface DiscordStatusUpdaterMetrics {
  setApiRequestsInWindow?: (value: number) => void
  setProviderUsageRatio?: (provider: string, model: string, ratio: number) => void
}

export interface DiscordStatusUpdater {
  setContextSize(tokens: number): void
  setCustomStatus(text: string | null): void
  setWorking(active: boolean): void
  start(client: Client): void
  stop(): void
}

/**
 * Create one Discord status updater with isolated status and timer state.
 * The config should be a snapshot for this runtime instance.
 */
export function createDiscordStatusUpdater(
  config: DiscordStatusUpdaterConfig,
  metrics: DiscordStatusUpdaterMetrics,
): DiscordStatusUpdater {
  let maxContextTokens: number | null = null
  let currentContextSize = 0
  let customStatusText: string | null = null
  let working = false
  let updateFn: (() => Promise<void>) | null = null
  let intervalHandle: ReturnType<typeof setInterval> | null = null
  let usageDisplay: string | null = null
  let modelInfoFetched = false

  const fetchModelContextLength = async (apiKey: string, baseUrl: string, modelId: string): Promise<void> => {
    try {
      const resp = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!resp.ok) return
      const data = (await resp.json()) as { data?: BridgeModel[] }
      const model = data.data?.find((m) => m.id === modelId)
      if (model?.context_length) {
        maxContextTokens = model.context_length
        console.log(`[status] model ${modelId} context_length: ${maxContextTokens}`)
      }
    } catch {}
  }

  const fetchBridgeUsage = async (apiKey: string, baseUrl: string, modelId: string): Promise<BridgeUsage | null> => {
    try {
      const resp = await fetch(`${baseUrl}/usage?model=${encodeURIComponent(modelId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      // 501/502 => provider has no usage concept (yet) or a transient failure.
      if (!resp.ok) return null
      const data = (await resp.json()) as BridgeUsage
      return data.available ? data : null
    } catch {
      return null
    }
  }

  const formatContext = (): string => {
    if (maxContextTokens) {
      const pct = Math.round((currentContextSize / maxContextTokens) * 100)
      return `${pct}%`
    }
    // Fallback: show raw token count (e.g. "205K")
    const k = Math.round(currentContextSize / 1000)
    return `${k}K`
  }

  const setContextSize = (tokens: number): void => {
    currentContextSize = tokens
  }

  /** Set a custom status prefix, or clear it with null/empty string. */
  const setCustomStatus = (text: string | null): void => {
    customStatusText = text && text.trim() ? text.trim() : null
    console.log(`[status] custom status ${customStatusText ? `set: "${customStatusText}"` : "cleared"}`)
    void updateFn?.()
  }

  /** Set working state and immediately refresh when it changes. */
  const setWorking = (active: boolean): void => {
    if (working === active) return
    working = active
    void updateFn?.()
  }

  const start = (client: Client): void => {
    if (intervalHandle) return

    const update = async () => {
      if (!client.user) return

      const apiKey = config.model.api_key
      if (!apiKey) return

      if (!modelInfoFetched && config.model.base_url && config.model.model) {
        await fetchModelContextLength(apiKey, config.model.base_url, config.model.model)
        modelInfoFetched = true
      }

      if (config.model.base_url && config.model.model) {
        const usage = await fetchBridgeUsage(apiKey, config.model.base_url, config.model.model)
        if (usage) {
          usageDisplay = usage.display ?? usageDisplay
          // Cross-provider usage ratio (0-1) — works for umans/codex/anthropic.
          if (typeof usage.percent === "number") {
            metrics.setProviderUsageRatio?.(usage.provider ?? "unknown", config.model.model, usage.percent)
          }
          // Keep the api-usage gauge fed when the provider exposes a raw window count.
          const raw = (usage.stats as { usage?: { requests_in_window?: number } } | undefined)?.usage?.requests_in_window
          if (typeof raw === "number") metrics.setApiRequestsInWindow?.(raw)
        }
      }

      const segments = [formatContext()]
      if (usageDisplay) segments.push(`[${usageDisplay}]`)
      const autoInfo = `${working ? "working " : ""}${segments.join(" ")}`

      const status = customStatusText
        ? `${customStatusText} | ${autoInfo}`
        : autoInfo

      try {
        await client.user.setActivity({
          name: status,
          state: status,
          type: 4,
        })
      } catch {}
    }

    void update()
    updateFn = update
    intervalHandle = setInterval(() => void update(), STATUS_INTERVAL_MS)
  }

  const stop = (): void => {
    if (intervalHandle) {
      clearInterval(intervalHandle)
      intervalHandle = null
    }
    updateFn = null
  }

  return { setContextSize, setCustomStatus, setWorking, start, stop }
}
