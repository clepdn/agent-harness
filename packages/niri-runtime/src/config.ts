/**
 * Runtime configuration loaded from TOML files passed via CLI flags.
 *
 * Values never touch `process.env` — anything secret stays inside this module
 * so spawned subprocesses (the agent's bash tool) don't inherit credentials.
 *
 *   coral --config /etc/coral/config.toml --secrets /etc/coral/secrets.toml.env
 *
 * Both flags are optional; missing values fall back to the defaults defined
 * below. `--config` may be repeated, in which case each file is deep-merged
 * over the previous one; secrets are then deep-merged on top of the result, so
 * a key declared in several places resolves to the last one that set it.
 */

import { existsSync, readFileSync } from "node:fs"
import { deepMerge, isTable, parseToml, type TomlTable, type TomlValue } from "@niri/toml"

// ── CLI flag parsing ──────────────────────────────────────────────────────────

function parseFlags(argv: string[]): { configPaths: string[]; secretsPath?: string } {
  // --config repeats: later files deep-merge over earlier ones, so a control
  // plane can layer a per-agent override on a shared base without rewriting it.
  const configPaths: string[] = []
  let secretsPath: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--config" || a === "-c") { const next = argv[++i]; if (next) configPaths.push(next) }
    else if (a === "--secrets" || a === "-s") secretsPath = argv[++i]
    else if (a?.startsWith("--config=")) configPaths.push(a.slice("--config=".length))
    else if (a?.startsWith("--secrets=")) secretsPath = a.slice("--secrets=".length)
  }
  return { configPaths, secretsPath }
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

function trimmedString(value: TomlValue | undefined): string {
  return typeof value === "string" ? value.trim() : ""
}

// Resolve the remote-bridge auth key, preferring an inline value over a file.
// The file path supports the NixOS/agenix "path to a secret" pattern, keeping
// the credential out of the config/secrets TOML. Throws when a key file is
// configured but unreadable, so coral fails closed instead of running
// unauthenticated.
function resolveBridgeApiKey(config: TomlTable): string {
  const inlineKey = trimmedString(config.llm_bridge_api_key)
  if (inlineKey) return inlineKey

  const keyFile = trimmedString(config.llm_bridge_api_key_file)
  if (!keyFile) return ""

  try {
    return readFileSync(keyFile, "utf8").trim()
  } catch (err) {
    throw new Error(
      `failed to read llm_bridge_api_key_file ${keyFile}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

const { configPaths, secretsPath } = parseFlags(process.argv.slice(2))

// Allow config path via env var (used by test runner where CLI flags conflict with node)
const resolvedConfigPaths = configPaths.length > 0
  ? configPaths
  : (process.env.CORAL_CONFIG ? [process.env.CORAL_CONFIG] : [])
const resolvedSecretsPath = secretsPath ?? process.env.CORAL_SECRETS

const baseTable = resolvedConfigPaths.reduce<TomlTable>((acc, file) => deepMerge(acc, loadFile(file)), {})
const secretsTable = resolvedSecretsPath ? loadFile(resolvedSecretsPath) : {}
const merged = deepMerge(baseTable, secretsTable)

const bridgeApiKey = resolveBridgeApiKey(merged)
if (bridgeApiKey) merged.llm_bridge_api_key = bridgeApiKey

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

  // If bridge = true on the preset, route through the llm_bridge_url
  // as a standard OpenAI-compatible endpoint, using llm_bridge_api_key
  // for authentication. A preset-level api_key wins if explicitly set on
  // the preset itself; any section-level api_key (including one deep-merged
  // from a stale secrets file) is discarded, since the bridge only accepts
  // its own key and sending anything else guarantees a 401.
  if (resolved.bridge === true) {
    const bridgeUrl = str(merged.llm_bridge_url, "").trim()
    if (bridgeUrl) {
      resolved.provider = "openai"
      resolved.base_url = bridgeUrl
    }
    const presetKey = str(preset.api_key, "").trim()
    const bridgeKey = str(merged.llm_bridge_api_key, "").trim()
    if (presetKey) {
      resolved.api_key = presetKey
    } else if (bridgeKey) {
      resolved.api_key = bridgeKey
    } else {
      delete resolved.api_key
    }
  }
  delete resolved.bridge

  return resolved
}

/**
 * Looks up a named model preset from [models.<name>] after config+secrets merge.
 * Returns the resolved TOML table (with secrets merged in) or null if not found.
 */
export function getModelPreset(name: string): Record<string, unknown> | null {
  const preset = modelsT[name.trim()]
  if (!isTable(preset)) return null
  // Resolve bridge/provider/api_key just like resolvePreset does at startup,
  // so runtime model swaps see the correct bridge url and key.
  const resolved = { ...preset }
  if (resolved.bridge === true) {
    const bridgeUrl = str(merged.llm_bridge_url, "").trim()
    if (bridgeUrl) {
      resolved.provider = "openai"
      resolved.base_url = bridgeUrl
    }
    const presetKey = str(preset.api_key, "").trim()
    const bridgeKey = str(merged.llm_bridge_api_key, "").trim()
    if (presetKey) {
      resolved.api_key = presetKey
    } else if (bridgeKey) {
      resolved.api_key = bridgeKey
    } else {
      delete resolved.api_key
    }
  }
  delete resolved.bridge
  return resolved
}

/**
 * Lists all available model preset names from [models.<name>].
 */
export function listModelPresets(): string[] {
  return Object.keys(modelsT).sort()
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
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string")
  // Accept the comma-separated spelling too: these fields were environment
  // variables before they were TOML, and both surfaces still hand us strings.
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean)
  return []
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
const remoteCompactionT = table(contextT.remote_compaction)
const runnerT = table(merged.runner)
const imageToolT = table(merged.image_tool)
const discordT = table(merged.discord)
const metricsT = table(merged.metrics)
const toolsT = table(merged.tools)
const llmBridgeT = table(merged.llm_bridge)
const computerUseT = table(merged.computer_use)
const prometheusT = table(merged.prometheus)
const webSearchT = table(merged.web_search)

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
const compactionStrategies = ["companion", "context-full", "snapcompact", "remote", "off"] as const

export type ToolChoice = (typeof toolChoices)[number]
export type ThinkingEffort = (typeof thinkingEfforts)[number]
export type CompactionStrategy = (typeof compactionStrategies)[number]

/** Validate an enum-valued config string, falling back on unknown values. */
function enumStr<T extends string>(value: TomlValue | undefined, allowed: readonly T[], fallback: T): T {
  const raw = str(value, fallback).trim().toLowerCase()
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
}

// The primary model config is built first so [context] can mirror the
// per-model values that moved onto the preset (compaction_strategy,
// compact_trigger_tokens, deep_archive, respect_prompt_cache).
const modelConfig = {
  provider: str(modelT.provider, "").trim(),
  model: str(modelT.model, "").trim(),
  base_url: str(modelT.base_url, "").trim(),
  api_key: str(modelT.api_key, "").trim(),
  tool_choice: pickEnum(modelT.tool_choice, toolChoices, "required"),
  enable_thinking: bool(modelT.enable_thinking, true),
  thinking_effort: pickEnum(modelT.thinking_effort, thinkingEfforts, "low"),
  vision: bool(modelT.vision, false),
  nudge_on_no_tool: bool(modelT.nudge_on_no_tool, false),
  // Minutes of session idle before a mid-session compaction pass runs. 0 = off.
  // Per-model because it's really about that model's context/cache behavior;
  // the global default stays 0 so it only turns on for presets that opt in.
  idle_compaction_minutes: num(modelT.idle_compaction_minutes, 0),
  // ── Per-model context behavior ──────────────────────────────────────────
  // These four used to live under [context]. They're really functions of the
  // model (its context window, its price cliffs, whether it does prompt
  // caching), so they belong on the preset and swap with the model at runtime.
  // Each falls back to the old [context] key for back-compat, then a default.
  //   compaction_strategy   - which compaction pipeline runs at the trigger
  //   compact_trigger_tokens- prompt-token count that fires compaction
  //   deep_archive          - preserve compressed-away specifics out-of-band
  //   respect_prompt_cache  - avoid history mutations that bust the prompt
  //                           cache (was preserve_prompt_cache)
  compaction_strategy: enumStr(
    modelT.compaction_strategy ?? contextT.compaction_strategy,
    compactionStrategies,
    "companion",
  ),
  compact_trigger_tokens: int(
    modelT.compact_trigger_tokens ?? contextT.compact_trigger_tokens,
    90000,
  ),
  deep_archive: bool(modelT.deep_archive ?? contextT.deep_archive, true),
  respect_prompt_cache: bool(
    // new name wins; fall back to the legacy per-model or [context] key
    modelT.respect_prompt_cache ??
      modelT.preserve_prompt_cache ??
      contextT.respect_prompt_cache ??
      contextT.preserve_prompt_cache,
    true,
  ),
}

export const config = {
  llm_bridge_url: str(merged.llm_bridge_url, "").trim(),
  llm_bridge_api_key: str(merged.llm_bridge_api_key, "").trim(),
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
  model: modelConfig,
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
    // NOTE: compaction_strategy, compact_trigger_tokens, deep_archive and
    // respect_prompt_cache moved to [model] (per-preset) — see config.model
    // above. These entries mirror the resolved PRIMARY model's values so any
    // consumer still reading config.context.* gets the effective primary value,
    // and a bare [context] key still works as a back-compat fallback.
    compaction_strategy: modelConfig.compaction_strategy,
    // Layer 3 toggle: archive compressed-away specifics into snapcompact frames
    // (Anthropic) or a remote snap payload (OpenAI). Independent of strategy so
    // "companion" can run with or without frames.
    deep_archive: modelConfig.deep_archive,
    // Run the journaling reflex over the span about to be burned before
    // summarizing (layer 1). Only meaningful for the companion strategy.
    journal_before_compaction: bool(contextT.journal_before_compaction, true),
    compact_target_tokens: int(contextT.compact_target_tokens, 65000),
    compact_trigger_tokens: modelConfig.compact_trigger_tokens,
    compact_recent_messages: int(contextT.compact_recent_messages, 80),
    compact_chunk_messages: int(contextT.compact_chunk_messages, 32),
    compact_summary_max_chars: int(contextT.compact_summary_max_chars, 16000),
    // Renamed from preserve_prompt_cache; mirrors the primary model's value.
    respect_prompt_cache: modelConfig.respect_prompt_cache,
    tool_result_compaction_min_age_turns: int(contextT.tool_result_compaction_min_age_turns, 5),
    tool_result_compaction_min_chars: int(contextT.tool_result_compaction_min_chars, 2000),
    tool_result_compaction_min_context_percent: num(contextT.tool_result_compaction_min_context_percent, 50),
    // Provider-native remote compaction (OpenAI). Empty endpoint disables it and
    // the "remote" strategy degrades to a local same-model summary.
    remote_compaction: {
      endpoint: str(remoteCompactionT.endpoint, "").trim(),
      model: str(remoteCompactionT.model, "").trim(),
      streaming_endpoint: str(remoteCompactionT.streaming_endpoint, "").trim(),
    },
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
    dm_whitelist: strArray(discordT.dm_whitelist),
    owner_id: str(discordT.owner_id, "").trim(),
    gateway_enabled: bool(discordT.gateway_enabled, true),
    gateway_trace: bool(discordT.gateway_trace, false),
    gateway_raw_fallback: bool(discordT.gateway_raw_fallback, true),
    gateway_raw_fallback_all: bool(discordT.gateway_raw_fallback_all, false),
    scan_channel_ids: strArray(discordT.scan_channel_ids),
    wake_on_event: bool(discordT.wake_on_event, false),
    wake_on_dm: bool(discordT.wake_on_dm, true),
    dm_wake_debounce_ms: Math.max(0, int(discordT.dm_wake_debounce_ms, 5000)),
    dm_wake_debounce_cap_ms: Math.max(0, int(discordT.dm_wake_debounce_cap_ms, 60000)),
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
    hashline: bool(toolsT.hashline, false),
  },
  llm_bridge: {
    enabled: bool(llmBridgeT.enabled, false),
    host: str(llmBridgeT.host, "127.0.0.1").trim(),
    port: int(llmBridgeT.port, 4040),
    providers: (() => {
      const raw = llmBridgeT.providers
      // Support attrset: { umans: { api_key, base_url, ... }, ... }
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const out: Record<string, Record<string, string>> = {}
        for (const [name, val] of Object.entries(raw as Record<string, TomlValue>)) {
          if (!isTable(val)) continue
          const entry = val as TomlTable
          out[name] = {
            api_key: str(entry.api_key, "").trim(),
            api_key_file: str(entry.api_key_file, "").trim(),
            base_url: str(entry.base_url, "").trim(),
            auth_path: str(entry.auth_path, "").trim(),
            model: str(entry.model, "").trim(),
            reasoning_effort: str(entry.reasoning_effort, "").trim(),
            client_id: str(entry.client_id, "").trim(),
            client_secret: str(entry.client_secret, "").trim(),
            refresh_token: str(entry.refresh_token, "").trim(),
            project_id: str(entry.project_id, "").trim(),
            binary_path: str(entry.binary_path, "").trim(),
          }
        }
        return out
      }
      return {}
    })(),
  },
  subagents: subagentConfigs,
  computer_use: {
    enabled: bool(computerUseT.enabled, false),
    display: str(computerUseT.display, "").trim(),
  },
  prometheus: {
    port: int(prometheusT.port, 9100),
  },
  web_search: {
    // Exa API key. When present and non-empty, the web_search tool is enabled.
    // Provisioned via the secrets TOML: [web_search] exa_api_key = "exa_..."
    exa_api_key: str(webSearchT.exa_api_key, "").trim(),
  },
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
    { label: "web_search.exa_api_key", value: config.web_search.exa_api_key },
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
