// Config for the LLM bridge.
// The bridge acts as our own OpenRouter — it routes requests to the best
// available provider using pi-ai's model registry + custom providers.
//
// Provider credentials written by the admin UI live in the bridge service's
// state directory. Startup restores the corresponding provider entries from
// those files before model discovery.

import fs from "node:fs"
import path from "node:path"
import { resolveCodexAuthPath } from "./codex"

export interface CustomProvider {
  // name is derived from the providers.<name> key — not stored as a field.
  api_key?: string
  api_key_file?: string
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
  // Providers keyed by name: { umans: { api_key, base_url, ... }, ... }
  providers: Record<string, CustomProvider>
  models: Record<string, BridgeModelConfig>
}

/**
 * Parse a TOML config file for standalone bridge deployments.
 * Supports: comments, [tables], [[array-of-tables]], basic strings,
 * integers, booleans, and single-line arrays of scalars.
 */
function parseTomlFile(path: string): Record<string, unknown> {
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

    // table: [section] or [section.subsection]
    const tableMatch = line.match(/^\[(.+)\]$/)
    if (tableMatch) {
      const parts = tableMatch[1]!.trim().split(".")
      let obj: Record<string, unknown> = root
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!.trim()
        const existing = obj[part]
        if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
          obj[part] = {}
        }
        obj = obj[part] as Record<string, unknown>
      }
      cursor = obj
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

export type SavedAuthProviderOptions = {
  /** Override the systemd state root in focused tests. */
  stateDirectory?: string
  /** Override the Codex resolver only in focused tests. */
  codexAuthPath?: string
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

/**
 * Restore provider entries written by the admin UI. The UI mutates the
 * in-memory config after login, so a restart needs to rebuild those entries
 * before discovery. Automatic restoration is limited to an explicit service
 * state root; an explicitly configured entry always wins, and an auth file is
 * only enough to add the matching provider, never the other one.
 *
 * Anthropic's file is the pi-shaped map at state/auth/anthropic.json. Codex's
 * file uses the CLI `tokens` shape and follows the same resolver used by the
 * request handler and admin login.
 */
export function addSavedAuthProviders(
  providers: Record<string, CustomProvider>,
  options: SavedAuthProviderOptions = {},
): Record<string, CustomProvider> {
  const out = { ...providers }
  const stateDirectory = options.stateDirectory === undefined
    ? process.env.STATE_DIRECTORY?.split(":")[0]?.trim() || process.env.BRIDGE_STATE_DIR?.trim()
    : options.stateDirectory.split(":")[0]?.trim()
  if (!stateDirectory) return out

  const anthropicAuthPath = path.join(stateDirectory, "auth", "anthropic.json")

  if (!Object.prototype.hasOwnProperty.call(out, "anthropic-oauth") && isRegularFile(anthropicAuthPath)) {
    out["anthropic-oauth"] = { auth_path: anthropicAuthPath }
  }

  const codexAuthPath = resolveCodexAuthPath(undefined, options.codexAuthPath)
  if (!Object.prototype.hasOwnProperty.call(out, "codex") && isRegularFile(codexAuthPath)) {
    out.codex = { auth_path: codexAuthPath }
  }

  return out
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

  let providers: Record<string, CustomProvider> = {}

  // From file config — providers is an object keyed by name
  if (fileConfig?.providers && typeof fileConfig.providers === "object" && !Array.isArray(fileConfig.providers)) {
    const raw = fileConfig.providers as Record<string, unknown>
    for (const [name, val] of Object.entries(raw)) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        providers[name] = val as CustomProvider
      }
    }
  }

  // From env var (harness-spawned case) — still JSON for backward compat
  if (Object.keys(providers).length === 0) {
    const providersJson = process.env.BRIDGE_PROVIDERS
    if (providersJson) {
      const parsed = JSON.parse(providersJson)
      // Support both object and array (legacy) format
      if (Array.isArray(parsed)) {
        for (const p of parsed) {
          if (p.name) providers[p.name] = p
        }
      } else {
        providers = parsed as Record<string, CustomProvider>
      }
    }
  }

  // Admin logins register providers only in memory; restore them from the
  // persistent service state before the empty-provider guard and discovery.
  providers = addSavedAuthProviders(providers)

  if (Object.keys(providers).length === 0) {
    throw new Error("[bridge] no providers configured. use --config <path> or set BRIDGE_PROVIDERS")
  }

  // Resolve api_key_file -> api_key for each provider
  for (const [name, provider] of Object.entries(providers)) {
    if (provider.api_key_file && !provider.api_key) {
      try {
        provider.api_key = fs.readFileSync(provider.api_key_file, "utf-8").trim()
        console.log(`[bridge] loaded api_key for provider "${name}" from ${provider.api_key_file}`)
      } catch (err) {
        console.error(`[bridge] failed to read api_key_file for provider "${name}": ${err}`)
      }
    }
  }

  return { port, host, providers, models: {} }
}

/**
 * Find a provider by name from the config.
 */
export function getProvider(config: BridgeConfig, name: string): CustomProvider | undefined {
  return config.providers[name]
}
