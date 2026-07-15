// Config for the LLM bridge.
// Reads from env vars or a TOML config file.

export interface BridgeModelConfig {
  id: string
  name: string
  provider: string
  baseUrl?: string
  apiKey: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  // Anthropic subscription OAuth — if set, the bridge manages token refresh
  oauthRefreshToken?: string
}

export interface BridgeConfig {
  port: number
  host: string
  models: Record<string, BridgeModelConfig>
  defaultModel: string
  keysPath?: string
}

export function loadConfig(): BridgeConfig {
  const port = parseInt(process.env.BRIDGE_PORT ?? "4040", 10)
  const host = process.env.BRIDGE_HOST ?? "127.0.0.1"

  // Keys file path from env or argv
  const keysArgIdx = process.argv.indexOf("--keys")
  const keysPath = process.env.BRIDGE_KEYS ?? (keysArgIdx >= 0 ? process.argv[keysArgIdx + 1] : undefined)

  // Model config from env: BRIDGE_MODEL_<NAME>=provider:model_id:api_key
  // Or from BRIDGE_MODELS as JSON
  const models: Record<string, BridgeModelConfig> = {}
  let defaultModel = ""

  const modelsJson = process.env.BRIDGE_MODELS
  if (modelsJson) {
    const parsed = JSON.parse(modelsJson) as BridgeModelConfig[]
    for (const m of parsed) {
      models[m.id] = m
      if (!defaultModel) defaultModel = m.id
    }
  }

  // Also support individual env vars
  const provider = process.env.BRIDGE_PROVIDER ?? process.env.MODEL_PROVIDER
  const modelId = process.env.BRIDGE_MODEL ?? process.env.MODEL_MODEL
  const apiKey = process.env.BRIDGE_API_KEY ?? process.env.MODEL_API_KEY
  const baseUrl = process.env.BRIDGE_BASE_URL ?? process.env.MODEL_BASE_URL
  const oauthRefreshToken = process.env.BRIDGE_OAUTH_REFRESH_TOKEN

  if (provider && modelId && (apiKey || oauthRefreshToken)) {
    const id = modelId
    models[id] = {
      id,
      name: modelId,
      provider,
      baseUrl,
      apiKey: apiKey ?? "", // will be filled from OAuth refresh
      ...(oauthRefreshToken ? { oauthRefreshToken } : {}),
      contextWindow: parseInt(process.env.BRIDGE_CONTEXT_WINDOW ?? "200000", 10),
      maxTokens: parseInt(process.env.BRIDGE_MAX_TOKENS ?? "8192", 10),
      reasoning: process.env.BRIDGE_REASONING === "true",
    }
    if (!defaultModel) defaultModel = id
  }

  if (!defaultModel) {
    throw new Error("[bridge] no models configured. set BRIDGE_MODELS or BRIDGE_PROVIDER + BRIDGE_MODEL + BRIDGE_API_KEY")
  }

  return { port, host, models, defaultModel, keysPath }
}
