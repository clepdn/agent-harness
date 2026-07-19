/**
 * Discord status updater — periodically sets the bot's custom activity
 * to show context usage and Umans API request count.
 *
 * Format: "x% [y/400]"
 *   x = context tokens used (as % of 400k)
 *   y = Umans API requests in current window
 *   400 = Umans hard cap (not the soft limit of 200)
 */

import type { Client } from "discord.js"
import { PRIMARY_API_KEY } from "../runner/config"
import { config } from "../config"

const STATUS_INTERVAL_MS = 60_000 // update every 60s
const MAX_CONTEXT_TOKENS = 400_000

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

/** Current context size — updated by the loop via setContextSize() */
let currentContextSize = 0

export function setContextSize(tokens: number): void {
  currentContextSize = tokens
}

let intervalHandle: ReturnType<typeof setInterval> | null = null
let lastRequests = 0

export function startStatusUpdater(client: Client): void {
  if (intervalHandle) return

  const update = async () => {
    if (!client.user) return

    // Fetch Umans usage
    const apiKey = config.model.api_key || PRIMARY_API_KEY
    if (!apiKey) return

    const usage = await fetchUmansUsage(apiKey)
    if (usage) {
      lastRequests = usage.usage.requests_in_window
    }

    const contextPct = Math.round((currentContextSize / MAX_CONTEXT_TOKENS) * 100)
    const status = `${contextPct}% [${lastRequests}/400]`

    try {
      await client.user.setActivity({
        name: status,
        state: status,
        type: 4, // ActivityType.Custom
      })
    } catch (err) {
      // Don't spam logs — Discord rate limits presence updates
    }
  }

  // Initial update
  void update()

  intervalHandle = setInterval(() => void update(), STATUS_INTERVAL_MS)
}

export function stopStatusUpdater(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}
