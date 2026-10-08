import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import type { AssistantMessage, TextContent, Usage } from "./llm"
import { config } from "./config"
import type { Message } from "./types"
import type { MemorySearchResult } from "./memory/index"

export interface BaseMetricEvent {
  timestamp: string
}

export interface PromptResponseMetric extends BaseMetricEvent {
  type: "prompt_response"
  model: string
  toolChoice?: string
  // Derived summary fields only — we deliberately do NOT store the full
  // messages[] or response body. They were hundreds of KB per turn, stored
  // for a detail view that the dashboard never rendered, and bloated
  // metrics.db to multiple GB. The list view only ever needs these.
  messageCount?: number
  lastUserMessage?: string
  responsePreview?: string
  toolCallCount?: number
  usage?: Usage
}

export interface MemoryMetric extends BaseMetricEvent {
  type: "memory"
  query: string
  results: MemorySearchResult[]
}

export interface CompactionMetric extends BaseMetricEvent {
  type: "compaction"
  before: number
  after: number
  method: string
  summary?: string
}

export interface UsageMetric extends BaseMetricEvent {
  type: "usage"
  usage: Usage
}

export type MetricEvent = PromptResponseMetric | MemoryMetric | CompactionMetric | UsageMetric

export type MetricListType = "response" | "summarization" | "memory" | "usage" | "discord"
export type MetricBucketName = "memories" | "summarization" | "response" | "usage" | "discord"

export type MetricListItem =
  | (BaseMetricListItem & {
      type: "response"
      promptMetricId?: number
      model?: string
      toolChoice?: string
      messageCount?: number
      lastUserMessage?: string
      responsePreview?: string
      toolCallCount?: number
      usage?: Usage
    })
  | (BaseMetricListItem & {
      type: "summarization"
      method?: string
      before?: number
      after?: number
      savedTokens?: number
      summaryPreview?: string
      summaryChars?: number
    })
  | (BaseMetricListItem & {
      type: "memory"
      queryPreview?: string
      resultCount?: number
    })
  | (BaseMetricListItem & {
      type: "usage"
      usage?: Usage
    })

export interface BaseMetricListItem extends BaseMetricEvent {
  id: number
  sourceType: MetricEvent["type"]
  detailPath: string
}

export interface MetricsQuery {
  limit?: number
  cursor?: number
  cursors?: Partial<Record<MetricBucketName, string | number>>
  type?: MetricListType[]
  includeRaw?: boolean
  q?: string
  from?: string
  to?: string
}

export interface DiscordMetricListItem extends BaseMetricEvent {
  id: string
  type: "discord"
  sourceType: "discord"
  detailPath: string
  messageId: string
  channelId: string
  guildId?: string
  authorId?: string
  authorUsername?: string
  contentPreview?: string
  isDm: boolean
  mentionsBot: boolean
  isFromBot: boolean
}

export interface MetricsPage {
  memories: MetricListItem[]
  summarization: MetricListItem[]
  response: MetricListItem[]
  usage: MetricListItem[]
  discord: DiscordMetricListItem[]
  limit: number
  nextCursor: Partial<Record<MetricBucketName, string | number>>
  hasMore: Partial<Record<MetricBucketName, boolean>>
  filters: {
    type?: MetricListType[]
    includeRaw: boolean
    q?: string
    from?: string
    to?: string
  }
}

export type MetricEventInput =
  | Omit<PromptResponseMetric, "timestamp">
  | Omit<MemoryMetric, "timestamp">
  | Omit<CompactionMetric, "timestamp">
  | Omit<UsageMetric, "timestamp">

interface MetricRow {
  id: number
  type: string
  payload: string
  createdAt: string
}

const MAX_METRIC_LIMIT = 200
const DEFAULT_METRIC_LIMIT = 100
const DEFAULT_METRICS_RETENTION_DAYS = 3
const METRICS_PRUNE_INTERVAL_MS = 60 * 60_000

export interface MetricsStore {
  recordMetric(event: MetricEventInput): number | null
  getMetrics(query?: MetricsQuery): MetricsPage
  getMetricDetail(id: number): (MetricEvent & { id: number }) | null
  getDiscordMetricDetail(id: string): (DiscordMetricListItem & { raw: unknown }) | null
  close(): void
}

function retentionCutoff(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60_000).toISOString()
}

function pruneOldMetrics(database: Database.Database, days: number): number {
  const result = database.prepare("delete from metrics where createdAt < ?").run(retentionCutoff(days))
  if (result.changes > 0) database.pragma("wal_checkpoint(PASSIVE)")
  return result.changes
}

export interface MetricsStoreOptions {
  readonly path?: string
  readonly nanoDb?: Database.Database
  readonly retentionDays?: number
  readonly home?: string
}
export function createMetricsStore(options: MetricsStoreOptions = {}): MetricsStore {
  const dbPath = options.path?.trim() || process.env.NANO_METRICS_DB_PATH?.trim() || path.join(options.home ?? process.env.NANO_HOME?.trim() ?? process.env.HOME ?? process.cwd(), "metrics.db")
  const inMemory = dbPath === ":memory:"
  if (!inMemory) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 })
    fs.accessSync(path.dirname(dbPath), fs.constants.W_OK)
  }
  const database = new Database(dbPath)
  if (!inMemory) fs.chmodSync(dbPath, 0o600)
  database.pragma("journal_mode = WAL")
  database.exec(`
    create table if not exists metrics (
      id integer primary key autoincrement,
      type text not null,
      payload text not null,
      createdAt text not null
    );
    create index if not exists idx_metrics_type on metrics(type);
    create index if not exists idx_metrics_created on metrics(createdAt desc);
    create index if not exists idx_metrics_type_id on metrics(type, id desc);
  `)
  const retentionDays = Number.isFinite(options.retentionDays) && options.retentionDays! > 0
    ? options.retentionDays!
    : config.metrics.retention_days > 0 ? config.metrics.retention_days : DEFAULT_METRICS_RETENTION_DAYS
  const prune = (): void => {
    try {
      const deleted = pruneOldMetrics(database, retentionDays)
      if (deleted > 0) console.log(`[metrics] pruned ${deleted} rows older than ${retentionDays} days`)
    } catch (error) {
      console.error("[metrics] failed to prune old metrics:", error)
    }
  }
  prune()
  const pruneTimer = setInterval(prune, METRICS_PRUNE_INTERVAL_MS)
  pruneTimer.unref?.()

  const store: MetricsStore = {
    recordMetric(event) {
      const timestamp = new Date().toISOString()
      try {
        const result = database.prepare("insert into metrics (type, payload, createdAt) values (?, ?, ?)")
          .run(event.type, JSON.stringify(event), timestamp)
        return Number(result.lastInsertRowid)
      } catch (error) {
        console.error("[metrics] failed to record to db:", error)
        return null
      }
    },
    getMetrics(query = {}) {
      const limit = clampLimit(query.limit)
      const includeRaw = query.includeRaw === true
      const types = normalizeListTypes(query.type)
      const selectedBuckets = new Set(types.map((type) => METRIC_TYPE_TO_BUCKET[type]))
      const nextCursor: Partial<Record<MetricBucketName, string | number>> = {}
      const hasMore: Partial<Record<MetricBucketName, boolean>> = {}
      const readMetricBucket = (type: MetricListType): MetricListItem[] => {
        const bucket = METRIC_TYPE_TO_BUCKET[type]
        if (!selectedBuckets.has(bucket)) return []
        const result = queryMetricBucket(database, type, bucket, query, limit)
        if (result.nextCursor != null) nextCursor[bucket] = result.nextCursor
        hasMore[bucket] = result.hasMore
        return result.items
      }
      let discord: DiscordMetricListItem[] = []
      if (selectedBuckets.has("discord") && options.nanoDb) {
        const result = queryDiscordBucket(options.nanoDb, query, limit)
        discord = result.items
        if (result.nextCursor != null) nextCursor.discord = result.nextCursor
        hasMore.discord = result.hasMore
      }
      return {
        memories: readMetricBucket("memory"),
        summarization: readMetricBucket("summarization"),
        response: readMetricBucket("response"),
        usage: readMetricBucket("usage"),
        discord,
        limit,
        nextCursor,
        hasMore,
        filters: { type: types, includeRaw, q: query.q, from: query.from, to: query.to },
      }
    },
    getMetricDetail(id) {
      const row = database.prepare("select id, type, payload, createdAt from metrics where id = ?").get(id) as MetricRow | undefined
      if (!row) return null
      try {
        const payload = JSON.parse(row.payload) as MetricEvent
        return { ...payload, id: row.id, timestamp: row.createdAt }
      } catch (error) {
        console.warn(`[metrics] skipping corrupt metric row ${row.id}: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },
    getDiscordMetricDetail(id) {
      if (!options.nanoDb) return null
      const row = options.nanoDb.prepare(
        `select message_id, channel_id, guild_id, author_id, author_username, content,
                created_at, is_dm, mentions_bot, is_from_bot, raw_json
         from discord_messages where message_id = ?`,
      ).get(id) as (DiscordMessageMetricRow & { raw_json: string }) | undefined
      if (!row) return null
      let raw: unknown
      try { raw = JSON.parse(row.raw_json) } catch { raw = row.raw_json }
      return {
        id: row.message_id,
        type: "discord",
        sourceType: "discord",
        timestamp: row.created_at,
        detailPath: `/metrics/discord/${row.message_id}`,
        messageId: row.message_id,
        channelId: row.channel_id,
        ...(row.guild_id ? { guildId: row.guild_id } : {}),
        ...(row.author_id ? { authorId: row.author_id } : {}),
        ...(row.author_username ? { authorUsername: row.author_username } : {}),
        contentPreview: preview(row.content),
        isDm: row.is_dm === 1,
        mentionsBot: row.mentions_bot === 1,
        isFromBot: row.is_from_bot === 1,
        raw,
      }
    },
    close() {
      clearInterval(pruneTimer)
      if (database.open) database.close()
    },
  }
  return store
}


const DEFAULT_LIST_TYPES: MetricListType[] = ["memory", "summarization", "response", "usage", "discord"]
const METRIC_TYPE_TO_SOURCE: Partial<Record<MetricListType, MetricEvent["type"]>> = {
  response: "prompt_response",
  summarization: "compaction",
  memory: "memory",
  usage: "usage",
}
const METRIC_TYPE_TO_BUCKET: Record<MetricListType, MetricBucketName> = {
  memory: "memories",
  summarization: "summarization",
  response: "response",
  usage: "usage",
  discord: "discord",
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_METRIC_LIMIT
  return Math.max(1, Math.min(MAX_METRIC_LIMIT, Math.floor(limit as number)))
}

function normalizeListTypes(type: MetricListType[] | undefined): MetricListType[] {
  if (!type || type.length === 0) return [...DEFAULT_LIST_TYPES]
  const normalized = [...new Set(type.filter((item): item is MetricListType => DEFAULT_LIST_TYPES.includes(item)))]
  return normalized.length ? normalized : [...DEFAULT_LIST_TYPES]
}

function preview(value: unknown, maxChars = 240): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.replace(/\s+/g, " ").trim()
  if (!normalized) return undefined
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`
}

function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  const parts = content.flatMap((part) => {
    if (!part || typeof part !== "object") return []
    const record = part as Record<string, unknown>
    return typeof record.text === "string" ? [record.text] : []
  })
  return parts.length ? parts.join("\n") : undefined
}

function lastUserMessage(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | undefined
    if (message?.role !== "user") continue
    const text = messageText(message.content)
    if (text) return preview(text)
  }
  return undefined
}

/** Summarize API exchanges without storing their full prompt and response text. */
export function summarizePromptResponse(
  messages: readonly Message[],
  response: AssistantMessage,
): Pick<PromptResponseMetric, "messageCount" | "lastUserMessage" | "responsePreview" | "toolCallCount"> {
  const responseText = response.content.filter((item) => item.type === "text")
    .map((item) => (item as TextContent).text).join("")
  return {
    messageCount: messages.length,
    lastUserMessage: lastUserMessage(messages),
    responsePreview: preview(messageText(responseText)),
    toolCallCount: response.content.filter((item) => item.type === "toolCall").length,
  }
}

function parseMetricRow(row: MetricRow): MetricListItem | null {
  let payload: Partial<MetricEvent> & Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(row.payload)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("payload is not an object")
    payload = parsed as Partial<MetricEvent> & Record<string, unknown>
  } catch (error) {
    console.warn(`[metrics] skipping corrupt metric row ${row.id}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  const base: BaseMetricListItem = {
    id: row.id,
    sourceType: row.type as MetricEvent["type"],
    timestamp: row.createdAt,
    detailPath: `/metrics/${row.id}`,
  }
  if (row.type === "prompt_response") return {
    ...base,
    type: "response",
    promptMetricId: row.id,
    model: typeof payload.model === "string" ? payload.model : undefined,
    toolChoice: typeof payload.toolChoice === "string" ? payload.toolChoice : undefined,
    messageCount: typeof payload.messageCount === "number" ? payload.messageCount : undefined,
    lastUserMessage: typeof payload.lastUserMessage === "string" ? payload.lastUserMessage : undefined,
    responsePreview: typeof payload.responsePreview === "string" ? payload.responsePreview : undefined,
    toolCallCount: typeof payload.toolCallCount === "number" ? payload.toolCallCount : undefined,
    usage: payload.usage as Usage | undefined,
  }
  if (row.type === "compaction") {
    const before = typeof payload.before === "number" ? payload.before : undefined
    const after = typeof payload.after === "number" ? payload.after : undefined
    const summary = typeof payload.summary === "string" ? payload.summary : undefined
    return {
      ...base, type: "summarization",
      method: typeof payload.method === "string" ? payload.method : undefined,
      before, after,
      savedTokens: typeof before === "number" && typeof after === "number" ? before - after : undefined,
      summaryPreview: preview(summary), summaryChars: summary?.length,
    }
  }
  if (row.type === "memory") return {
    ...base, type: "memory", queryPreview: preview(payload.query),
    resultCount: Array.isArray(payload.results) ? payload.results.length : undefined,
  }
  if (row.type === "usage") return { ...base, type: "usage", usage: payload.usage as Usage | undefined }
  return null
}

function metricCursor(query: MetricsQuery, bucket: MetricBucketName): number | undefined {
  const raw = query.cursors?.[bucket] ?? query.cursor
  const value = typeof raw === "string" ? parseInt(raw, 10) : raw
  return Number.isFinite(value) ? Math.floor(value as number) : undefined
}

function queryMetricBucket(
  database: Database.Database,
  type: MetricListType,
  bucket: MetricBucketName,
  query: MetricsQuery,
  limit: number,
): { items: MetricListItem[]; nextCursor?: number; hasMore: boolean } {
  const sourceType = METRIC_TYPE_TO_SOURCE[type]
  if (!sourceType) return { items: [], hasMore: false }
  const where = ["type = ?"]
  const params: Array<string | number> = [sourceType]
  const cursor = metricCursor(query, bucket)
  if (cursor) { where.push("id < ?"); params.push(cursor) }
  if (query.from) { where.push("createdAt >= ?"); params.push(query.from) }
  if (query.to) { where.push("createdAt <= ?"); params.push(query.to) }
  if (query.q?.trim()) { where.push("payload like ?"); params.push(`%${query.q.trim()}%`) }
  const rows = database.prepare(
    `select id, type, payload, createdAt from metrics where ${where.join(" and ")} order by id desc limit ?`,
  ).all(...params, limit + 1) as MetricRow[]
  const pageRows = rows.slice(0, limit)
  const items = pageRows.flatMap((row) => {
    const item = parseMetricRow(row)
    return item ? [item] : []
  })
  const last = pageRows[pageRows.length - 1]
  return { items, nextCursor: rows.length > limit && last ? last.id : undefined, hasMore: rows.length > limit }
}

type DiscordMessageMetricRow = {
  message_id: string
  channel_id: string
  guild_id: string | null
  author_id: string | null
  author_username: string | null
  content: string
  created_at: string
  is_dm: number
  mentions_bot: number
  is_from_bot: number
}

function queryDiscordBucket(
  database: Database.Database,
  query: MetricsQuery,
  limit: number,
): { items: DiscordMetricListItem[]; nextCursor?: string; hasMore: boolean } {
  const where: string[] = []
  const params: Array<string | number> = []
  const cursor = query.cursors?.discord
  if (typeof cursor === "string" && cursor.trim()) { where.push("created_at < ?"); params.push(cursor) }
  if (query.from) { where.push("created_at >= ?"); params.push(query.from) }
  if (query.to) { where.push("created_at <= ?"); params.push(query.to) }
  if (query.q?.trim()) {
    where.push("(content like ? or author_username like ? or channel_id like ?)")
    const like = `%${query.q.trim()}%`
    params.push(like, like, like)
  }
  const rows = database.prepare(`
    select message_id, channel_id, guild_id, author_id, author_username, content,
           created_at, is_dm, mentions_bot, is_from_bot
    from discord_messages ${where.length ? `where ${where.join(" and ")}` : ""}
    order by created_at desc limit ?
  `).all(...params, limit + 1) as DiscordMessageMetricRow[]
  const pageRows = rows.slice(0, limit)
  const items = pageRows.map((row) => ({
    id: row.message_id, type: "discord" as const, sourceType: "discord" as const,
    timestamp: row.created_at, detailPath: `/metrics/discord/${row.message_id}`,
    messageId: row.message_id, channelId: row.channel_id,
    ...(row.guild_id ? { guildId: row.guild_id } : {}),
    ...(row.author_id ? { authorId: row.author_id } : {}),
    ...(row.author_username ? { authorUsername: row.author_username } : {}),
    contentPreview: preview(row.content),
    isDm: row.is_dm === 1, mentionsBot: row.mentions_bot === 1, isFromBot: row.is_from_bot === 1,
  }))
  const last = pageRows[pageRows.length - 1]
  return { items, nextCursor: rows.length > limit && last ? last.created_at : undefined, hasMore: rows.length > limit }
}
