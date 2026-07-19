/**
 * Discord status updater — periodically sets the bot's custom activity
 * to show context usage and Umans API request count.
 *
 * Format (model info available):  "x% [y/400]"
 * Format (model info unavailable): "205K [y/400]"
 */

import type { Client } from "discord.js"
import { config } from "../config"

const STATUS_INTERVAL_MS = 60_000

interface UmansUsage {
  usage: { requests_in_window: number }
  limits: { requests: { hard_cap: number } }
}

interface UmansModel {
  id: string
  context_length?: number
}

let maxContextTokens: number | null = null

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

function formatContext(): string {
  if (maxContextTokens) {
    const pct = Math.round((currentContextSize / maxContextTokens) * 100)
    return `${pct}%`
  }
  // Fallback: show raw token count (e.g. "205K")
  const k = Math.round(currentContextSize / 1000)
  return `${k}K`
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

    if (!modelInfoFetched && config.model.base_url && config.model.model) {
      await fetchModelContextLength(apiKey, config.model.base_url, config.model.model)
      modelInfoFetched = true
    }

    const usage = await fetchUmansUsage(apiKey)
    if (usage) {
      lastRequests = usage.usage.requests_in_window
    }

    const status = `${formatContext()} [${lastRequests}/400]`

    try {
      await client.user.setActivity({
        name: status,
        state: status,
        type: 4,
      })
    } catch {}
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
