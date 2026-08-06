import fs from "node:fs"
import path from "node:path"
import { deepMerge, parseToml, type TomlTable } from "@nano/toml"

/**
 * An agent file describes what the control plane owns — identity, port, home,
 * which tool client to attach — and then points at the same runtime TOML a
 * standalone `nano --config` invocation would read. Model, fallback, discord,
 * tools and the rest are deliberately absent: duplicating that schema here is
 * what let the two surfaces drift apart in the first place.
 */
export type AgentFile = {
  id?: string
  name?: string
  port?: number
  home?: string
  client?: string
  workspace?: string
  config?: string[]
  secrets?: string
  settings?: Record<string, string | number | boolean>
}

export type ResolvedLocalAgent = {
  id: string
  name: string
  port: number
  home: string
  client: string
  workspace?: string
  config: string[]
  secrets?: string
  settings: Record<string, string>
  source: string
}

const AGENT_KEYS = new Set([
  "id",
  "name",
  "port",
  "home",
  "client",
  "workspace",
  "config",
  "secrets",
  "settings",
])

const RESERVED_SETTINGS = new Set([
  "AGENT_ID",
  "AGENT_NAME",
  "NANO_CONFIG",
  "NANO_SECRETS",
  "HOME",
  "NANO_AGENT_ID",
  "NANO_AGENT_STATE_DIR",
  "NANO_CLIENT",
  "NANO_CLIENT_WORKSPACE",
  "NANO_CONTROL_DB",
  "NANO_CONTROL_HOME",
  "NANO_HOME",
  "NANO_MANAGED_WORKER",
  "NANO_RESTART_COMMAND",
  "NANO_RESTART_CWD",
  "NANO_WORKER_HOST",
  "NANO_WORKER_INSTANCE_ID",
  "PORT",
])

const SAFE_PARENT_SETTINGS = new Set([
  "COLORTERM",
  "LANG",
  "NO_COLOR",
  "NODE_OPTIONS",
  "PATH",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
])

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

/**
 * `config` accepts one path or an ordered list. Each file is deep-merged over
 * the previous one by the worker, exactly as repeated `--config` flags do, so
 * agents can share a base file and layer their own differences on top.
 */
function optionalPathList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (typeof item !== "string" || !item.trim()) throw new Error(`${label}[${index}] must be a non-empty string`)
      return item.trim()
    })
  }
  const single = optionalString(value, label)
  return single ? [single] : undefined
}

function parseSettings(value: unknown, label: string): Record<string, string | number | boolean> | undefined {
  if (value === undefined) return undefined
  const item = object(value, label)
  const result: Record<string, string | number | boolean> = {}
  for (const [key, raw] of Object.entries(item)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`${label}.${key} must use an uppercase runtime setting name`)
    if (
      RESERVED_SETTINGS.has(key) ||
      key.startsWith("NANO_CLIENT_") ||
      key.startsWith("NANO_CONTROL_") ||
      key.startsWith("NANO_TOOL_CLIENT_") ||
      key.startsWith("NANO_WORKER_")
    ) {
      throw new Error(`${label}.${key} is managed by the server`)
    }
    if (!["string", "number", "boolean"].includes(typeof raw)) throw new Error(`${label}.${key} must be a string, number, or boolean`)
    result[key] = raw as string | number | boolean
  }
  return result
}

export function parseAgentFile(filePath: string): AgentFile {
  let raw: unknown
  try {
    raw = parseToml(fs.readFileSync(filePath, "utf8"))
  } catch (error) {
    throw new Error(`${filePath}: invalid toml: ${error instanceof Error ? error.message : String(error)}`)
  }
  const item = object(raw, filePath)
  const unknown = Object.keys(item).filter((key) => !AGENT_KEYS.has(key))
  if (unknown.length > 0) throw new Error(`${filePath}: unknown keys: ${unknown.join(", ")}`)
  if (item.port !== undefined && (typeof item.port !== "number" || !Number.isInteger(item.port))) {
    throw new Error(`${filePath}: port must be an integer`)
  }

  const configPaths = optionalPathList(item.config, `${filePath}.config`)

  return {
    ...(optionalString(item.id, `${filePath}.id`) ? { id: String(item.id).trim() } : {}),
    ...(optionalString(item.name, `${filePath}.name`) ? { name: String(item.name).trim() } : {}),
    ...(typeof item.port === "number" ? { port: item.port } : {}),
    ...(optionalString(item.home, `${filePath}.home`) ? { home: String(item.home).trim() } : {}),
    ...(optionalString(item.client, `${filePath}.client`) ? { client: String(item.client).trim() } : {}),
    ...(optionalString(item.workspace, `${filePath}.workspace`) ? { workspace: String(item.workspace).trim() } : {}),
    ...(configPaths ? { config: configPaths } : {}),
    ...(optionalString(item.secrets, `${filePath}.secrets`) ? { secrets: String(item.secrets).trim() } : {}),
    ...(item.settings !== undefined ? { settings: parseSettings(item.settings, `${filePath}.settings`) } : {}),
  }
}

export function loadAgentFiles(directory: string): Array<{ config: AgentFile; source: string }> {
  if (!fs.existsSync(directory)) throw new Error(`agent directory does not exist: ${directory}`)
  const files = fs.readdirSync(directory)
    .filter((name) => /\.toml$/i.test(name) && !/\.example\.toml$/i.test(name))
    .sort()
  if (files.length === 0) throw new Error(`no agent toml files found in ${directory}`)
  return files.map((name) => {
    const source = path.join(directory, name)
    return { config: parseAgentFile(source), source }
  })
}

function agentSettings(config: AgentFile): Record<string, string> {
  const settings: Record<string, string> = {}
  for (const [key, value] of Object.entries(config.settings ?? {})) settings[key] = String(value)
  return settings
}

function resolveConfigPath(value: string, repoRoot: string, label: string): string {
  const resolved = path.isAbsolute(value) ? value : path.join(repoRoot, value)
  if (!fs.existsSync(resolved)) throw new Error(`${label}: config file not found: ${resolved}`)
  return resolved
}

export function resolveLocalAgents(
  files: Array<{ config: AgentFile; source: string }>,
  options: { controlPort: number; repoRoot: string },
): ResolvedLocalAgent[] {
  const resolved = files.map(({ config, source }, index) => {
    const id = (config.id ?? path.basename(source).replace(/\.toml$/i, "")).trim()
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`${source}: invalid agent id ${id}`)
    const port = config.port ?? options.controlPort + index + 1
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === options.controlPort) {
      throw new Error(`${source}: invalid worker port ${port}`)
    }
    const home = canonicalPath(config.home
      ? (path.isAbsolute(config.home) ? config.home : path.join(options.repoRoot, config.home))
      : path.join(options.repoRoot, "data", "agents", id))
    const client = config.client?.trim()
    if (!client) throw new Error(`${source}: client is required`)
    if (client !== "local") {
      const url = new URL(client)
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error(`${source}: client must be local or an HTTP(S) URL without credentials`)
      }
    }
    const workspace = config.workspace
      ? canonicalPath(path.isAbsolute(config.workspace) ? config.workspace : path.join(options.repoRoot, config.workspace))
      : undefined
    return {
      id,
      name: config.name ?? id,
      port,
      home,
      client,
      ...(workspace ? { workspace } : {}),
      config: (config.config ?? []).map((file) => resolveConfigPath(file, options.repoRoot, source)),
      ...(config.secrets ? { secrets: resolveConfigPath(config.secrets, options.repoRoot, source) } : {}),
      settings: agentSettings(config),
      source,
    }
  })

  assertUnique(resolved, "id", (agent) => agent.id)
  assertUnique(resolved, "port", (agent) => String(agent.port))
  assertUnique(resolved, "home", (agent) => agent.home)
  return resolved
}

function canonicalPath(value: string): string {
  const suffix: string[] = []
  let current = path.resolve(value)
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    suffix.unshift(path.basename(current))
    current = parent
  }
  return path.join(fs.realpathSync.native(current), ...suffix)
}

function assertUnique<T>(items: T[], label: string, key: (item: T) => string): void {
  const owners = new Map<string, number>()
  items.forEach((item, index) => {
    const value = key(item)
    const prior = owners.get(value)
    if (prior !== undefined) throw new Error(`agents at indexes ${prior} and ${index} share ${label}`)
    owners.set(value, index)
  })
}

/**
 * Resolves the same table the worker will build: every `--config` layer in
 * order, then secrets on top. Unreadable files are skipped rather than fatal —
 * the worker reports those far more precisely than a startup guard can.
 */
export function effectiveRuntimeConfig(agent: ResolvedLocalAgent): TomlTable {
  const layers = [...agent.config, ...(agent.secrets ? [agent.secrets] : [])]
  return layers.reduce<TomlTable>((table, file) => {
    try {
      return deepMerge(table, parseToml(fs.readFileSync(file, "utf8")))
    } catch {
      return table
    }
  }, {})
}

/**
 * Two workers driving one Discord bot double-process every event, so the token
 * has to be unique across agents wherever it was declared.
 */
export function assertNoDuplicateDiscordTokens(agents: ResolvedLocalAgent[]): void {
  const owners = new Map<string, string>()
  for (const agent of agents) {
    const discord = effectiveRuntimeConfig(agent).discord
    const raw = discord && typeof discord === "object" && !Array.isArray(discord) ? discord.bot_token : undefined
    const token = typeof raw === "string" ? raw.trim() : ""
    if (!token) continue
    const prior = owners.get(token)
    if (prior) throw new Error(`agents ${prior} and ${agent.id} share [discord].bot_token`)
    owners.set(token, agent.id)
  }
}

export function assertNoDuplicateBridgePorts(agents: ResolvedLocalAgent[], controlPort: number): void {
  const owners = new Map<number, string>()
  const workerPorts = new Map(agents.map((agent) => [agent.port, agent.id]))
  for (const agent of agents) {
    for (const bridge of [
      { name: "Antigravity", enabled: "ANTIGRAVITY_BRIDGE_ENABLED", port: "ANTIGRAVITY_BRIDGE_PORT", fallback: "8000" },
      { name: "Codex", enabled: "CODEX_BRIDGE_ENABLED", port: "CODEX_BRIDGE_PORT", fallback: "8001" },
    ] as const) {
      if (agent.settings[bridge.enabled]?.trim().toLowerCase() !== "true") continue
      const port = Number.parseInt(agent.settings[bridge.port] ?? bridge.fallback, 10)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid ${bridge.name} bridge port for ${agent.id}`)
      const workerOwner = workerPorts.get(port)
      if (port === controlPort || workerOwner) {
        throw new Error(`${bridge.name} bridge port ${port} conflicts with ${port === controlPort ? "the control plane" : `worker ${workerOwner}`}`)
      }
      const owner = `${agent.id} ${bridge.name}`
      const prior = owners.get(port)
      if (prior) throw new Error(`${prior} and ${owner} bridges share port ${port}`)
      owners.set(port, owner)
    }
  }
}

export function buildWorkerEnvironment(parentEnv: NodeJS.ProcessEnv, agent: ResolvedLocalAgent): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(parentEnv)) {
    if (SAFE_PARENT_SETTINGS.has(key) || key.startsWith("LC_")) env[key] = value
  }
  Object.assign(env, agent.settings, {
    HOME: agent.home,
    NANO_AGENT_ID: agent.id,
    NANO_HOME: agent.home,
    NANO_CLIENT: agent.client,
    ...(agent.workspace ? { NANO_CLIENT_WORKSPACE: agent.workspace } : {}),
    PORT: String(agent.port),
    NANO_WORKER_HOST: "127.0.0.1",
    NANO_MANAGED_WORKER: "true",
    NANO_MIGRATE_LEGACY_STATE: agent.settings.NANO_MIGRATE_LEGACY_STATE ?? "false",
  })
  return env
}
