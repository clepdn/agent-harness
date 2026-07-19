/**
 * Discord status updater — periodically sets the bot's custom activity
 * to show context usage and Umans API request count.
 *
 * Format: "x% [y/400]"
 *   x = context tokens used (as % of model's context_length)
 *   y = Umans API requests in current window
 *   400 = Umans hard cap (not the soft limit of 200)
 */

import type { Client } from "discord.js"
import { config } from "../config"

const STATUS_INTERVAL_MS = 60_000

interface UmansUsage {
  usage: {
    requests_in_window: number
  }
  limits: {
    requests: {
      hard_cap: number
    }
  }
}

interface UmansModel {
  id: string
  context_length?: number
}

let maxContextTokens = 400_000 // fallback, overwritten on first fetch

/** Current context size — updated by the loop via setContextSize() */
let currentContextSize = 0

export function setContextSize(tokens: number): void {
  currentContextSize = tokens
}

async function fetchModelContextLength(apiKey: string, baseUrl: string, modelId: string): Promise<void> {
  try {
    const resp = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!resp.ok) return
    const data = (await resp.json()) as { data?: UmansModel[] }
    const model = data.data?.find((m) => m.id === modelId)
    if (model?.context_length) {
      maxContextTokens = model.context_length
      console.log(`[status] model ${modelId} context_length: ${maxContextTokens}`)
    }
  } catch {}
}

async function fetchUmansUsage(apiKey: string): Promise<UmansUsage | null> {
  try {
    const resp = await fetch("https://api.code.umans.ai/v1/usage", {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!resp.ok) return null
    return (await resp.json()) as UmansUsage
  } catch {
    return null
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null
let lastRequests = 0
let modelInfoFetched = false

export function startStatusUpdater(client: Client): void {
  if (intervalHandle) return

  const update = async () => {
    if (!client.user) return

    const apiKey = config.model.api_key
    if (!apiKey) return

    // Fetch model context_length once on first run
    if (!modelInfoFetched && config.model.base_url && config.model.model) {
      await fetchModelContextLength(apiKey, config.model.base_url, config.model.model)
      modelInfoFetched = true
    }

    // Fetch Umans usage
    const usage = await fetchUmansUsage(apiKey)
    if (usage) {
      lastRequests = usage.usage.requests_in_window
    }

    const contextPct = Math.round((currentContextSize / maxContextTokens) * 100)
    const status = `${contextPct}% [${lastRequests}/400]`

    try {
      await client.user.setActivity({
        name: status,
        state: status,
        type: 4, // ActivityType.Custom
      })
    } catch {
      // Discord rate limits presence updates
    }
  }

  void update()
  intervalHandle = setInterval(() => void update(), STATUS_INTERVAL_MS)
}

export function stopStatusUpdater(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}
