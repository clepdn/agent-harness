// Config for the LLM bridge.
// The bridge acts as our own OpenRouter — it routes requests to the best
// available provider using pi-ai's model registry + custom providers.

export interface CustomProvider {
  name: string
  //通用 (umans, etc.)
  api_key?: string
  base_url?: string
  // Path to the provider's auth.json (codex + anthropic-oauth).
  auth_path?: string
  // codex
  model?: string
  reasoning_effort?: string
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
  // Path to a pi-ai auth.json file holding the Anthropic OAuth credential.
  // When set, tokens are read/refreshed/rotated in-place on disk.
  authPath?: string
}

export interface BridgeConfig {
  port: number
  host: string
  providers: CustomProvider[]
  models: Record<string, BridgeModelConfig>
}

/**
 * Parse a TOML config file for standalone bridge deployments.
 * Supports: comments, [tables], [[array-of-tables]], basic strings,
 * integers, booleans, and single-line arrays of scalars.
 */
function parseTomlFile(path: string): Record<string, unknown> {
  const fs = require("node:fs")
  const text = fs.readFileSync(path, "utf-8")
  const root: Record<string, unknown> = {}
  let cursor: Record<string, unknown> = root

  for (const raw of text.split(/\r?\n/)) {
    // strip comments (but not # inside quotes)
    let inStr = false
    let line = ""
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!
      if (ch === '"' && raw[i - 1] !== "\\") inStr = !inStr
      if (ch === "#" && !inStr) break
      line += ch
    }
    line = line.trim()
    if (!line) continue

    // array-of-tables: [[providers]]
    const aotMatch = line.match(/^\[\[(.+)\]\]$/)
    if (aotMatch) {
      const key = aotMatch[1]!.trim()
      const existing = root[key]
      const arr: unknown[] = Array.isArray(existing) ? (existing as unknown[]) : []
      const obj: Record<string, unknown> = {}
      arr.push(obj)
      root[key] = arr
      cursor = obj
      continue
    }

    // table: [section]
    const tableMatch = line.match(/^\[(.+)\]$/)
    if (tableMatch) {
      const key = tableMatch[1]!.trim()
      const existing = root[key]
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
        root[key] = {}
      }
      cursor = root[key] as Record<string, unknown>
      continue
    }

    // key = value
    const eqIdx = line.indexOf("=")
    if (eqIdx < 0) continue
    const key = line.slice(0, eqIdx).trim()
    let val: unknown
    const rawVal = line.slice(eqIdx + 1).trim()

    if (rawVal === "true") val = true
    else if (rawVal === "false") val = false
    else if (/^-?\d+$/.test(rawVal)) val = parseInt(rawVal, 10)
    else if (/^-?\d+\.\d+$/.test(rawVal)) val = parseFloat(rawVal)
    else if (rawVal.startsWith('"') && rawVal.endsWith('"')) val = rawVal.slice(1, -1)
    else if (rawVal.startsWith("[")) {
      // single-line array
      const inner = rawVal.slice(1, -1)
      val = inner.split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean)
    } else val = rawVal

    cursor[key] = val
  }

  return root
}

export function loadConfig(): BridgeConfig {
  // Check for --config flag
  const configArgIdx = process.argv.indexOf("--config")
  const configPath = configArgIdx >= 0 ? process.argv[configArgIdx + 1] : undefined

  let fileConfig: Record<string, unknown> | null = null
  if (configPath) {
    try {
      fileConfig = parseTomlFile(configPath)
      console.log(`[bridge] loaded config from ${configPath}`)
    } catch (err) {
      console.warn(`[bridge] failed to load config from ${configPath}: ${err}`)
    }
  }

  // File config takes priority, env vars are fallback
  const port = fileConfig?.port
    ? parseInt(String(fileConfig.port), 10)
    : parseInt(process.env.BRIDGE_PORT ?? "4040", 10)
  const host = (fileConfig?.host as string) ?? process.env.BRIDGE_HOST ?? "127.0.0.1"

  let providers: CustomProvider[] = []

  // From file config
  if (fileConfig?.providers && Array.isArray(fileConfig.providers)) {
    providers = fileConfig.providers as CustomProvider[]
  }

  // From env var (harness-spawned case)
  if (providers.length === 0) {
    const providersJson = process.env.BRIDGE_PROVIDERS
    if (providersJson) {
      providers = JSON.parse(providersJson) as CustomProvider[]
    }
  }

  if (providers.length === 0) {
    throw new Error("[bridge] no providers configured. use --config <path> or set BRIDGE_PROVIDERS")
  }

  return { port, host, providers, models: {} }
}

/**
 * Find a provider by name from the config.
 */
export function getProvider(config: BridgeConfig, name: string): CustomProvider | undefined {
  return config.providers.find((p) => p.name === name)
}
