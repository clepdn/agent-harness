// Config for the LLM bridge.
// The bridge acts as our own OpenRouter — it routes requests to the best
// available provider using pi-ai's model registry + custom providers.

export interface CustomProvider {
  name: string
  //通用 (umans, etc.)
  api_key?: string
  base_url?: string
  oauth_refresh_token?: string
  // codex
  model?: string
  reasoning_effort?: string
  auth_path?: string
  // antigravity
  client_id?: string
  client_secret?: string
  refresh_token?: string
  project_id?: string
  binary_path?: string
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
  models: Record<string, BridgeModelConfig>
}

export function loadConfig(): BridgeConfig {
  const port = parseInt(process.env.BRIDGE_PORT ?? "4040", 10)
  const host = process.env.BRIDGE_HOST ?? "127.0.0.1"

  const providersJson = process.env.BRIDGE_PROVIDERS
  let providers: CustomProvider[] = []
  if (providersJson) {
    providers = JSON.parse(providersJson) as CustomProvider[]
  }

  if (providers.length === 0) {
    throw new Error("[bridge] no providers configured. set BRIDGE_PROVIDERS")
  }

  return { port, host, providers, models: {} }
}

/**
 * Find a provider by name from the config.
 */
export function getProvider(config: BridgeConfig, name: string): CustomProvider | undefined {
  return config.providers.find((p) => p.name === name)
}
