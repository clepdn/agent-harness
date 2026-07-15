/**
 * Runtime configuration loaded from TOML files passed via CLI flags.
 *
 * Values never touch `process.env` — anything secret stays inside this module
 * so spawned subprocesses (the agent's bash tool) don't inherit credentials.
 *
 *   coral --config /etc/coral/config.toml --secrets /etc/coral/secrets.toml.env
 *
 * Both flags are optional; missing values fall back to the defaults defined
 * below. Secrets are deep-merged on top of config so a key declared in both
 * resolves to the secrets value.
 */

import { existsSync, readFileSync } from "node:fs"

// ── Tiny TOML parser ──────────────────────────────────────────────────────────
// Handles: comments, [tables], nested [a.b] tables, basic and literal strings,
// integers, floats, booleans, and single-line arrays of scalars. That's enough
// for the config schema below.

type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue }
type TomlTable = Record<string, TomlValue>

function parseToml(text: string): TomlTable {
  const root: TomlTable = {}
  let cursor: TomlTable = root

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim()
    if (!line) continue

    // Array-of-tables header: [[key]] or [[a.b]]
    // Each occurrence creates a fresh table and appends it to an array.
    if (line.startsWith("[[") && line.endsWith("]]")) {
      const path = line.slice(2, -2).trim()
      if (!path) throw new Error("empty array-of-tables header")
      cursor = root
      const segments = path.split(".")
      for (let i = 0; i < segments.length; i++) {
        const key = segments[i]!.trim()
        const isLast = i === segments.length - 1
        const existing = cursor[key]
        if (isLast) {
          // Create or append to the array of tables
          if (existing === undefined) {
            cursor[key] = []
          } else if (!Array.isArray(existing)) {
            throw new Error(`table path "${path}" overlaps a non-array value at "${key}"`)
          }
          const arr = cursor[key] as TomlValue[]
          const fresh: TomlTable = {}
          arr.push(fresh)
          cursor = fresh
        } else {
          // Navigate through intermediate keys
          if (existing === undefined) {
            const fresh: TomlTable = {}
            cursor[key] = fresh
            cursor = fresh
          } else if (isTable(existing)) {
            cursor = existing
          } else if (Array.isArray(existing)) {
            // Use the last element of an existing array-of-tables
            const last = existing[existing.length - 1]
            if (!isTable(last)) throw new Error(`cannot navigate into non-table array element at "${key}"`)
            cursor = last
          } else {
            throw new Error(`table path "${path}" overlaps a non-table value at "${key}"`)
          }
        }
      }
      continue
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      const path = line.slice(1, -1).trim()
      if (!path) throw new Error("empty table header")
      cursor = root
      for (const segment of path.split(".")) {
        const key = segment.trim()
        const next = cursor[key]
        if (next === undefined) {
          const fresh: TomlTable = {}
          cursor[key] = fresh
          cursor = fresh
        } else if (isTable(next)) {
          cursor = next
        } else {
          throw new Error(`table path "${path}" overlaps a non-table value`)
        }
      }
      continue
    }

    const eq = line.indexOf("=")
    if (eq <= 0) throw new Error(`invalid TOML line: ${raw}`)
    const key = line.slice(0, eq).trim()
    cursor[key] = parseValue(line.slice(eq + 1).trim())
  }
  return root
}

function stripComment(line: string): string {
  let inString = false
  let quote = ""
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inString) {
      if (c === "\\") { i++; continue }
      if (c === quote) inString = false
    } else if (c === '"' || c === "'") {
      inString = true
      quote = c
    } else if (c === "#") {
      return line.slice(0, i)
    }
  }
  return line
}

function parseValue(text: string): TomlValue {
  if (!text) throw new Error("missing TOML value")
  if (text.startsWith('"') && text.endsWith('"')) return JSON.parse(text) as string
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1)
  if (text === "true") return true
  if (text === "false") return false
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim()
    if (!inner) return []
    return splitArrayItems(inner).map(parseValue)
  }
  const num = Number(text)
  if (Number.isFinite(num)) return num
  throw new Error(`could not parse TOML value: ${text}`)
}

function splitArrayItems(text: string): string[] {
  const items: string[] = []
  let depth = 0
  let inString = false
  let quote = ""
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === "\\") { i++; continue }
      if (c === quote) inString = false
    } else if (c === '"' || c === "'") {
      inString = true
      quote = c
    } else if (c === "[") depth++
    else if (c === "]") depth--
    else if (c === "," && depth === 0) {
      items.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  const last = text.slice(start).trim()
  if (last) items.push(last)
  return items
}

// ── CLI flag parsing ──────────────────────────────────────────────────────────

function parseFlags(argv: string[]): { configPath?: string; secretsPath?: string } {
  let configPath: string | undefined
  let secretsPath: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--config" || a === "-c") configPath = argv[++i]
    else if (a === "--secrets" || a === "-s") secretsPath = argv[++i]
    else if (a?.startsWith("--config=")) configPath = a.slice("--config=".length)
    else if (a?.startsWith("--secrets=")) secretsPath = a.slice("--secrets=".length)
  }
  return { configPath, secretsPath }
}

// ── Loading & merging ─────────────────────────────────────────────────────────

function loadFile(path: string): TomlTable {
  if (!existsSync(path)) throw new Error(`config file not found: ${path}`)
  try {
    return parseToml(readFileSync(path, "utf8"))
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function deepMerge(base: TomlTable, overlay: TomlTable): TomlTable {
  const out: TomlTable = { ...base }
  for (const [k, v] of Object.entries(overlay)) {
    const baseValue = out[k]
    out[k] = isTable(baseValue) && isTable(v) ? deepMerge(baseValue, v) : v
  }
  return out
}

const { configPath, secretsPath } = parseFlags(process.argv.slice(2))

// Allow config path via env var (used by test runner where CLI flags conflict with node)
const resolvedConfigPath = configPath ?? process.env.CORAL_CONFIG
const resolvedSecretsPath = secretsPath ?? process.env.CORAL_SECRETS

const baseTable = resolvedConfigPath ? loadFile(resolvedConfigPath) : {}
const secretsTable = resolvedSecretsPath ? loadFile(resolvedSecretsPath) : {}
const merged = deepMerge(baseTable, secretsTable)

// ── Model preset resolution ───────────────────────────────────────────────────
// Sections ([model], [fallback], [summary], [embeddings]) can reference a named
// preset defined under [models.<name>]. The preset provides defaults; the
// section's own fields override. Resolution happens after the config+secrets
// deep merge, so api_keys from the secrets file merge into presets naturally.

function resolvePreset(section: TomlValue | undefined, presets: TomlTable): TomlTable {
  const t = table(section)
  const presetName = t.preset
  if (typeof presetName !== "string" || !presetName.trim()) return t
  const preset = presets[presetName.trim()]
  if (!isTable(preset)) {
    throw new Error(`model preset "${presetName}" not found in [models]`)
  }
  const resolved = deepMerge(preset, t)
  delete resolved.preset
  return resolved
}

// ── Typed accessors ───────────────────────────────────────────────────────────

function table(value: TomlValue | undefined): TomlTable {
  return isTable(value) ? value : {}
}

function str(value: TomlValue | undefined, fallback: string): string {
  return typeof value === "string" ? value : fallback
}

function num(value: TomlValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function int(value: TomlValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback
}

function bool(value: TomlValue | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function strArray(value: TomlValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}

function pickEnum<T extends string>(value: TomlValue | undefined, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

const serverT = table(merged.server)
const agentT = table(merged.agent)
const containerT = table(merged.container)
const sshT = table(merged.ssh)
const modelsT = table(merged.models)
const modelT = resolvePreset(merged.model, modelsT)
const fallbackT = resolvePreset(merged.fallback, modelsT)
const summaryT = resolvePreset(merged.summary, modelsT)
const embeddingsT = resolvePreset(merged.embeddings, modelsT)
const contextT = table(merged.context)
const runnerT = table(merged.runner)
const imageToolT = table(merged.image_tool)
const discordT = table(merged.discord)
const metricsT = table(merged.metrics)
const toolsT = table(merged.tools)
const llmBridgeT = table(merged.llm_bridge)

// ── Subagent configs (array of tables) ────────────────────────────────────────

export interface SubagentConfig {
  name: string
  model: string
  system_prompt: string
  enabled_tools: string[]
  blacklisted_tools: string[]
  max_turns: number
}

const subagentConfigs: SubagentConfig[] = (() => {
  const raw = merged.subagents
  if (!Array.isArray(raw)) return []
  return raw
    .filter((entry): entry is TomlTable => isTable(entry))
    .map((entry) => ({
      name: str(entry.name, "").trim(),
      model: str(entry.model, "").trim(),
      system_prompt: str(entry.system_prompt, ""),
      enabled_tools: strArray(entry.enabled_tools),
      blacklisted_tools: strArray(entry.blacklisted_tools),
      max_turns: int(entry.max_turns, 30),
    }))
    .filter((sa) => sa.name.length > 0)
})()

const toolChoices = ["required", "auto", "none"] as const
const thinkingEfforts = ["minimal", "low", "medium", "high", "xhigh"] as const

export type ToolChoice = (typeof toolChoices)[number]
export type ThinkingEffort = (typeof thinkingEfforts)[number]

export const config = {
  server: {
    port: int(serverT.port, 3000),
  },
  agent: {
    name: str(agentT.name, "").trim() || "niri",
    env: str(agentT.env, "default").trim().toLowerCase(),
    boredom_wake_min: num(agentT.boredom_wake_min, 0),
    git_upstream_nag: bool(agentT.git_upstream_nag, false),
  },
  container: {
    name: str(containerT.name, "").trim(),
    user: str(containerT.user, "").trim(),
  },
  ssh: {
    target: str(sshT.target, "").trim(),
    identity: str(sshT.identity, "").trim(),
  },
  model: {
    provider: str(modelT.provider, "").trim(),
    model: str(modelT.model, "").trim(),
    base_url: str(modelT.base_url, "").trim(),
    api_key: str(modelT.api_key, "").trim(),
    tool_choice: pickEnum(modelT.tool_choice, toolChoices, "required"),
    enable_thinking: bool(modelT.enable_thinking, true),
    thinking_effort: pickEnum(modelT.thinking_effort, thinkingEfforts, "low"),
  },
  fallback: {
    provider: str(fallbackT.provider, "").trim(),
    model: str(fallbackT.model, "").trim() || "zai-org/glm-4.7-flash",
    base_url: str(fallbackT.base_url, "").trim(),
    api_key: str(fallbackT.api_key, "").trim(),
    tool_choice: pickEnum(fallbackT.tool_choice, toolChoices, "required"),
    referer: str(fallbackT.referer, "").trim(),
    title: str(fallbackT.title, "").trim(),
    enforce_context_limit:
      typeof fallbackT.enforce_context_limit === "boolean"
        ? (fallbackT.enforce_context_limit as boolean)
        : undefined,
    n_ctx: int(fallbackT.n_ctx, 4096),
    context_margin: int(fallbackT.context_margin, 256),
    hard_overflow_tokens: int(fallbackT.hard_overflow_tokens, 1024),
  },
  summary: {
    provider: str(summaryT.provider, "").trim(),
    model: str(summaryT.model, "").trim(),
    base_url: str(summaryT.base_url, "").trim(),
    api_key: str(summaryT.api_key, "").trim(),
    referer: str(summaryT.referer, "").trim(),
    title: str(summaryT.title, "").trim(),
  },
  embeddings: {
    model: str(embeddingsT.model, "google/gemini-embedding-2-preview"),
    dimensions: int(embeddingsT.dimensions, 3072),
    base_url: str(embeddingsT.base_url, "https://openrouter.ai/api/v1"),
    api_key: str(embeddingsT.api_key, "").trim(),
    referer: str(embeddingsT.referer, "").trim(),
    title: str(embeddingsT.title, "").trim(),
  },
  context: {
    compact_target_tokens: int(contextT.compact_target_tokens, 65000),
    compact_trigger_tokens: int(contextT.compact_trigger_tokens, 90000),
    compact_recent_messages: int(contextT.compact_recent_messages, 80),
    compact_chunk_messages: int(contextT.compact_chunk_messages, 32),
    compact_summary_max_chars: int(contextT.compact_summary_max_chars, 16000),
    idle_compaction_minutes: num(contextT.idle_compaction_minutes, 45),
    respect_cache: bool(contextT.respect_cache, true),
    compaction_turn_age: int(contextT.compaction_turn_age, 5),
    compaction_min_chars: int(contextT.compaction_min_chars, 2000),
  },
  runner: {
    max_turns: int(runnerT.max_turns, 120),
    max_identical_tool_turns: int(runnerT.max_identical_tool_turns, 10),
  },
  image_tool: {
    max_bytes: int(imageToolT.max_bytes, 150000),
    root: str(imageToolT.root, "").trim(),
  },
  discord: {
    bot_token: str(discordT.bot_token, "").trim(),
    bot_user_id: str(discordT.bot_user_id, "").trim(),
    gateway_enabled: bool(discordT.gateway_enabled, true),
    gateway_trace: bool(discordT.gateway_trace, false),
    gateway_raw_fallback: bool(discordT.gateway_raw_fallback, true),
    gateway_raw_fallback_all: bool(discordT.gateway_raw_fallback_all, false),
    scan_channel_ids: strArray(discordT.scan_channel_ids),
    wake_on_event: bool(discordT.wake_on_event, false),
    wake_on_dm: bool(discordT.wake_on_dm, true),
    batch_interval_ms: Math.max(1000, int(discordT.batch_interval_ms, 60000)),
    batch_only_configured: bool(discordT.batch_only_configured, true),
    pending_auto_seen_minutes: int(discordT.pending_auto_seen_minutes, 10),
    batch_scan: bool(discordT.batch_scan, true),
    batch_max_messages: int(discordT.batch_max_messages, 40),
    rest_max_attempts: int(discordT.rest_max_attempts, 3),
    rest_retry_base_ms: int(discordT.rest_retry_base_ms, 1000),
  },
  metrics: {
    retention_days: num(metricsT.retention_days, 3),
  },
  tools: {
    enabled_tools: strArray(toolsT.enabled_tools),
    blacklisted_tools: strArray(toolsT.blacklisted_tools),
  },
  llm_bridge: {
    enabled: bool(llmBridgeT.enabled, false),
    host: str(llmBridgeT.host, "127.0.0.1").trim(),
    port: int(llmBridgeT.port, 4040),
    api_key: str(llmBridgeT.api_key, "").trim(),
    base_url: str(llmBridgeT.base_url, "").trim(),
  },
  subagents: subagentConfigs,
}

/**
 * Records the bot's user id once discovered from the gateway READY payload.
 * Used because the bot id may not be known until after first connect.
 */
export function setDiscordBotUserId(id: string): void {
  if (!id) return
  ;(config.discord as { bot_user_id: string }).bot_user_id = id
}

// ── Secret redaction ──────────────────────────────────────────────────────────
// Defense in depth: even though secrets stay out of process.env, a misbehaving
// command (curl -v, env printout, sloppy logging) can still echo them. Scrub
// any occurrence before the value reaches conversation state, the db, or the
// stream.

const MIN_SECRET_LENGTH = 8

type SecretEntry = { label: string; value: string }

function collectSecrets(): SecretEntry[] {
  const entries: SecretEntry[] = [
    { label: "model.api_key",      value: config.model.api_key },
    { label: "fallback.api_key",   value: config.fallback.api_key },
    { label: "summary.api_key",    value: config.summary.api_key },
    { label: "embeddings.api_key", value: config.embeddings.api_key },
    { label: "discord.bot_token",  value: config.discord.bot_token },
  ]
  return entries.filter((e) => e.value.length >= MIN_SECRET_LENGTH)
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

let cachedPattern: { regex: RegExp; labels: string[] } | null = null

function buildPattern(): { regex: RegExp; labels: string[] } | null {
  const secrets = collectSecrets()
  if (secrets.length === 0) return null

  // Longest-first so partial overlaps don't shadow longer secret matches.
  const sorted = [...secrets].sort((a, b) => b.value.length - a.value.length)
  const labels = sorted.map((s) => s.label)
  const parts = sorted.map((s) => `(${escapeForRegex(s.value)})`)
  return { regex: new RegExp(parts.join("|"), "g"), labels }
}

/**
 * Replaces every occurrence of a known secret value with `[redacted:<label>]`.
 * Returns the input unchanged when no secrets are configured or none match.
 */
export function redactSecrets(text: string): string {
  if (!text) return text
  if (!cachedPattern) cachedPattern = buildPattern()
  if (!cachedPattern) return text

  const { regex, labels } = cachedPattern
  regex.lastIndex = 0
  return text.replace(regex, (_match, ...groups) => {
    // Last two args from String.replace are offset + full string; ignore them.
    const captures = groups.slice(0, labels.length) as (string | undefined)[]
    const hitIndex = captures.findIndex((g) => g !== undefined)
    const label = hitIndex >= 0 ? labels[hitIndex] : "secret"
    return `[redacted:${label}]`
  })
}
