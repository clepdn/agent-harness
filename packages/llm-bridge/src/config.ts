// Config for the LLM bridge.
// The bridge acts as our own OpenRouter — it proxies to an upstream
// OpenAI-compatible API and auto-discovers available models.

export interface UpstreamModel {
  id: string
  context_length?: number
  owned_by?: string
}

export interface BridgeConfig {
  port: number
  host: string
  // Upstream connection — all non-antigravity/codex models are proxied here
  upstreamBaseUrl: string
  upstreamApiKey: string
  // Discovered models (fetched on startup from upstream /v1/models)
  models: UpstreamModel[]
}

export function loadConfig(): BridgeConfig {
  const port = parseInt(process.env.BRIDGE_PORT ?? "4040", 10)
  const host = process.env.BRIDGE_HOST ?? "127.0.0.1"
  const upstreamBaseUrl = (process.env.BRIDGE_BASE_URL ?? "").replace(/\/+$/, "")
  const upstreamApiKey = process.env.BRIDGE_API_KEY ?? ""

  if (!upstreamBaseUrl || !upstreamApiKey) {
    throw new Error("[bridge] BRIDGE_BASE_URL and BRIDGE_API_KEY are required (upstream API connection)")
  }

  return { port, host, upstreamBaseUrl, upstreamApiKey, models: [] }
}
