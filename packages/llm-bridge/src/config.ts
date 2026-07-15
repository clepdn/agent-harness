// Config for the LLM bridge.
// The bridge acts as our own OpenRouter — it routes requests to the best
// available provider using pi-ai's model registry + custom providers.

export interface CustomProvider {
  name: string
  api_key?: string
  base_url?: string
  oauth_refresh_token?: string
}

export interface BridgeModelConfig {
  id: string
  name: string
  provider: string
  baseUrl?: string
  apiKey: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  oauthRefreshToken?: string
}

export interface BridgeConfig {
  port: number
  host: string
  providers: CustomProvider[]
  // Models discovered at startup (from custom providers + pi-ai registry)
  models: Record<string, BridgeModelConfig>
}

export function loadConfig(): BridgeConfig {
  const port = parseInt(process.env.BRIDGE_PORT ?? "4040", 10)
  const host = process.env.BRIDGE_HOST ?? "127.0.0.1"

  // Providers passed as JSON from the runtime
  const providersJson = process.env.BRIDGE_PROVIDERS
  let providers: CustomProvider[] = []
  if (providersJson) {
    providers = JSON.parse(providersJson) as CustomProvider[]
  }

  // Also support individual env vars for standalone use
  const singleProvider = process.env.BRIDGE_PROVIDER
  const singleApiKey = process.env.BRIDGE_API_KEY
  const singleBaseUrl = process.env.BRIDGE_BASE_URL
  const singleOAuth = process.env.BRIDGE_OAUTH_REFRESH_TOKEN
  if (singleProvider && (singleApiKey || singleOAuth)) {
    providers.push({
      name: singleProvider,
      ...(singleApiKey ? { api_key: singleApiKey } : {}),
      ...(singleBaseUrl ? { base_url: singleBaseUrl } : {}),
      ...(singleOAuth ? { oauth_refresh_token: singleOAuth } : {}),
    })
  }

  if (providers.length === 0) {
    throw new Error("[bridge] no providers configured. set BRIDGE_PROVIDERS or BRIDGE_PROVIDER + BRIDGE_API_KEY")
  }

  return { port, host, providers, models: {} }
}
