/**
 * Discord message search — exact lookup plus background semantic indexing.
 *
 * @module discord/search
 */

import { createHash } from "crypto"
import type Database from "better-sqlite3"
import type { RuntimeKind } from "../runner/types"
import { assertDiscordChannelAccess, filterDiscordRowsForRuntime } from "./access"
import { getOrCreateDiscordFriendlyId, resolveDiscordChannelId } from "./friendly-id"
import { MEMORY_SEMANTIC_MIN_SIMILARITY, normalizeText, type DiscordMemorySearchResult } from "../memory/shared"

export type DiscordEmbeddings = {
  configured(): boolean
  dimensions: number
  model: string
  embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]>
}

const DISCORD_MEMORY_EMBEDDING_DIMENSIONS = 3072

const DISCORD_EMBEDDING_BATCH_SIZE = Math.max(
  1,
  Math.min(512, Number.parseInt(process.env.DISCORD_EMBEDDING_BATCH_SIZE ?? "64", 10) || 64),
)
const DISCORD_SEARCH_CATCHUP_BATCH_SIZE = Math.max(
  0,
  Math.min(128, Number.parseInt(process.env.DISCORD_SEARCH_CATCHUP_BATCH_SIZE ?? "16", 10) || 16),
)
const DISCORD_EMBEDDING_IDLE_MS = Math.max(
  1_000,
  Number.parseInt(process.env.DISCORD_EMBEDDING_IDLE_MS ?? "30000", 10) || 30_000,
)
const DISCORD_EMBEDDING_RETRY_MS = Math.max(
  1_000,
  Number.parseInt(process.env.DISCORD_EMBEDDING_RETRY_MS ?? "60000", 10) || 60_000,
)

type DiscordSearchRow = {
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
  guild_name: string | null
  channel_name: string | null
}

type DiscordEmbeddingRow = DiscordSearchRow & {
  model: string | null
  dimensions: number | null
  content_hash: string | null
}

type PendingDiscordEmbeddingRow = DiscordEmbeddingRow & {
  embedding_text: string
  next_hash: string
}

export type DiscordEmbeddingSyncResult = {
  embedded: number
  selected: number
  skipped?: string
}

export type DiscordEmbeddingBackfillHandle = {
  stop: () => void
}

function embeddingHash(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function vectorParam(vector: number[]): Float32Array {
  return new Float32Array(vector)
}

function embeddingText(row: DiscordSearchRow): string {
  const location = row.is_dm === 1
    ? `dm:${row.channel_id}`
    : [row.guild_name ?? row.guild_id, row.channel_name ? `#${row.channel_name}` : row.channel_id]
        .filter(Boolean)
        .join("/")
  return [
    `channel: ${location}`,
    row.author_username ? `author: @${row.author_username}` : null,
    `time: ${row.created_at}`,
    row.content,
  ].filter((part): part is string => Boolean(part && part.trim())).join("\n")
}

function formatHumanTimestamp(value: string | null | undefined): string {
  if (!value) return "unknown time"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  })
}

function publicRow(db: Database.Database, row: DiscordSearchRow, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: getOrCreateDiscordFriendlyId(db, row.message_id, row.channel_id),
    message_id: row.message_id,
    source_item_id: row.message_id,
    channel_id: row.channel_id,
    guild_id: row.guild_id,
    guild_name: row.guild_name,
    channel_name: row.channel_name,
    author_id: row.author_id,
    author_username: row.author_username,
    content: row.content,
    created_at: formatHumanTimestamp(row.created_at),
    is_dm: row.is_dm === 1,
    mentions_bot: row.mentions_bot === 1,
    is_from_bot: row.is_from_bot === 1,
    ...extra,
  }
}

function getMessage(db: Database.Database, channelId: string, messageId: string): DiscordSearchRow | null {
  const row = db.prepare<unknown[], DiscordSearchRow>(`select
     m.message_id, m.channel_id, m.guild_id, m.author_id, m.author_username,
     m.content, m.created_at, m.is_dm, m.mentions_bot, m.is_from_bot,
     c.guild_name, c.channel_name
   from discord_messages m
   left join discord_channels c on c.channel_id = m.channel_id
   where m.channel_id = ? and m.message_id = ?`).get(channelId, messageId)
  return row ?? null
}

function discordEmbeddingUnavailableReason(embeddings: DiscordEmbeddings | undefined, vecAvailable: () => boolean): string | null {
  if (!vecAvailable()) return "sqlite-vec unavailable"
  if (!embeddings?.configured()) return "embeddings disabled: set EMBEDDING_API_KEY"
  if (embeddings.dimensions !== DISCORD_MEMORY_EMBEDDING_DIMENSIONS) {
    return `embedding dimension mismatch: configured ${embeddings.dimensions}, expected ${DISCORD_MEMORY_EMBEDDING_DIMENSIONS}`
  }
  return null
}

function cleanupDiscordEmbeddingOrphans(db: Database.Database): void {
  db.prepare("delete from discord_message_embedding_meta where message_id not in (select message_id from discord_messages)").run()
  db.prepare("delete from discord_message_vec where rowid not in (select cast(message_id as integer) from discord_messages)").run()
}



/**
 * Embeds one bounded batch of pending Discord messages.
 *
 * Repeated calls continue through the backlog. This is deliberately batch-based
 * for checkpointing; the startup backfill loop calls it continuously.
 */
/**
 * True for errors where retrying the same request can never succeed without
 * operator intervention (bad/disabled key, quota exhausted). These must halt
 * the worker rather than trigger batch subdivision, which only multiplies spend.
 */
function isFatalEmbeddingError(err: unknown): boolean {
  const record = err && typeof err === "object" ? err : undefined
  const status = record && "status" in record ? record.status : record && "code" in record ? record.code : undefined
  if (status === 401 || status === 403 || status === 429) return true
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    msg.includes("user not found") ||
    msg.includes("unauthorized") ||
    msg.includes("invalid api key") ||
    msg.includes("quota") ||
    msg.includes("insufficient")
  )
}

export class FatalEmbeddingError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = "FatalEmbeddingError"
  }
}

export async function syncDiscordMessageEmbeddingsBatch(
  db: Database.Database,
  embeddings: DiscordEmbeddings,
  vecAvailable: () => boolean,
  params?: { channelId?: string; limit?: number },
): Promise<DiscordEmbeddingSyncResult> {
  const skipped = discordEmbeddingUnavailableReason(embeddings, vecAvailable)
  if (skipped) return { embedded: 0, selected: 0, skipped }

  cleanupDiscordEmbeddingOrphans(db)

  const channelId = String(params?.channelId ?? "").trim()
  const limit = Math.max(1, Math.min(512, Math.trunc(params?.limit ?? DISCORD_EMBEDDING_BATCH_SIZE) || DISCORD_EMBEDDING_BATCH_SIZE))
  const rows = db.prepare<unknown[], DiscordEmbeddingRow>(`select
     m.message_id, m.channel_id, m.guild_id, m.author_id, m.author_username,
     m.content, m.created_at, m.is_dm, m.mentions_bot, m.is_from_bot,
     c.guild_name, c.channel_name,
     e.model, e.dimensions, e.content_hash
   from discord_messages m
   left join discord_channels c on c.channel_id = m.channel_id
   left join discord_message_embedding_meta e on e.message_id = m.message_id
   where (? = '' or m.channel_id = ?)
     and not exists (
       select 1 from discord_memory_prunes p where p.message_id = m.message_id
     )
     and m.message_id not glob '*[^0-9]*'
     and (
       e.message_id is null
       or e.model != ?
       or e.dimensions != ?
     )
   order by cast(m.message_id as integer) asc
   limit ?`).all(channelId, channelId, embeddings.model, DISCORD_MEMORY_EMBEDDING_DIMENSIONS, limit)

  const pending = rows
    .map((row) => {
      const text = embeddingText(row)
      return { ...row, embedding_text: text, next_hash: embeddingHash(text) }
    })
    .filter(
      (row) =>
        row.model !== embeddings.model ||
        row.dimensions !== DISCORD_MEMORY_EMBEDDING_DIMENSIONS ||
        row.content_hash !== row.next_hash,
    )

  if (pending.length === 0) return { embedded: 0, selected: rows.length }

  const upsertMeta = db.prepare(`
    insert into discord_message_embedding_meta (message_id, model, dimensions, content_hash, updated_at)
    values (?, ?, ?, ?, datetime('now'))
    on conflict(message_id) do update set
      model = excluded.model,
      dimensions = excluded.dimensions,
      content_hash = excluded.content_hash,
      updated_at = datetime('now')
  `)
  const upsertVector = db.prepare("insert or replace into discord_message_vec(rowid, embedding) values (?, ?)")
  const isPruned = db.prepare("select 1 from discord_memory_prunes where message_id = ?")

  let embedded = 0
  let quarantined = 0
  const embedPendingRows = async (batch: PendingDiscordEmbeddingRow[]): Promise<void> => {
    let vectors: number[][]
    try {
      vectors = await embeddings.embedTexts(batch.map((row) => row.embedding_text))
    } catch (err) {
      // Request failures are not per-row problems; subdivision only multiplies spend.
      if (isFatalEmbeddingError(err)) throw err
      if (batch.length <= 1) throw err
      const midpoint = Math.ceil(batch.length / 2)
      console.warn(
        `[discord embeddings] embed call for batch of ${batch.length} failed; retrying as ${midpoint}+${batch.length - midpoint}: ${err instanceof Error ? err.message : String(err)}`,
      )
      await embedPendingRows(batch.slice(0, midpoint))
      await embedPendingRows(batch.slice(midpoint))
      return
    }

    db.transaction(() => {
      batch.forEach((row, index) => {
        if (isPruned.get(row.message_id)) return
        const vector = vectors[index]
        if (!vector) {
          quarantined += 1
          return
        }
        const quarantine = (reason: string) => {
          console.warn(`[discord embeddings] skipping message ${row.message_id}: ${reason}`)
          try {
            upsertMeta.run(row.message_id, embeddings.model, DISCORD_MEMORY_EMBEDDING_DIMENSIONS, row.next_hash)
          } catch {
            // meta write for a malformed id can also fail; nothing more to do
          }
          quarantined += 1
        }
        if (vector.length !== DISCORD_MEMORY_EMBEDDING_DIMENSIONS) {
          quarantine(`dimension ${vector.length} != ${DISCORD_MEMORY_EMBEDDING_DIMENSIONS}`)
          return
        }
        if (!/^[0-9]+$/.test(row.message_id)) {
          quarantine("non-numeric message id")
          return
        }
        try {
          upsertVector.run(BigInt(row.message_id), vectorParam(vector))
          upsertMeta.run(row.message_id, embeddings.model, DISCORD_MEMORY_EMBEDDING_DIMENSIONS, row.next_hash)
          embedded += 1
        } catch (rowErr) {
          quarantine(rowErr instanceof Error ? rowErr.message : String(rowErr))
        }
      })
    })()
  }

  try {
    await embedPendingRows(pending)
  } catch (err) {
    if (isFatalEmbeddingError(err)) throw new FatalEmbeddingError(err)
    throw err
  }

  return { embedded, selected: rows.length }
}

/**
 * Starts a non-blocking worker that continuously embeds pending Discord
 * messages until caught up, then wakes periodically for new messages.
 */
export function startDiscordEmbeddingBackfill(
  db: Database.Database,
  embeddings: DiscordEmbeddings | undefined,
  vecAvailable: () => boolean,
): DiscordEmbeddingBackfillHandle {
  const enabled = (process.env.DISCORD_EMBEDDING_BACKFILL ?? "true").trim().toLowerCase() !== "false"
  let stopped = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let batches = 0
  let totalEmbedded = 0
  let loggedIdle = false
  let loggedSkip: string | null = null

  const schedule = (delayMs: number) => {
    if (stopped) return
    timer = setTimeout(() => { void tick() }, delayMs)
    if (typeof timer.unref === "function") timer.unref()
  }

  const tick = async () => {
    if (stopped || running) return
    running = true
    try {
      if (!embeddings) {
        schedule(DISCORD_EMBEDDING_IDLE_MS)
        return
      }
      const result = await syncDiscordMessageEmbeddingsBatch(db, embeddings, vecAvailable)
      if (result.skipped) {
        if (loggedSkip !== result.skipped) {
          console.warn(`[discord embeddings] skipped: ${result.skipped}`)
          loggedSkip = result.skipped
        }
        schedule(DISCORD_EMBEDDING_IDLE_MS)
        return
      }

      if (result.embedded > 0) {
        batches += 1
        totalEmbedded += result.embedded
        loggedIdle = false
        if (batches === 1 || batches % 10 === 0) {
          console.log(`[discord embeddings] backfill embedded=${totalEmbedded} latest_batch=${result.embedded}`)
        }
        schedule(0)
        return
      }

      if (!loggedIdle) {
        console.log(`[discord embeddings] caught up embedded=${totalEmbedded}`)
        loggedIdle = true
      }
      schedule(DISCORD_EMBEDDING_IDLE_MS)
    } catch (err) {
      if (err instanceof FatalEmbeddingError) {
        console.error(`[discord embeddings] fatal error, halting backfill (no auto-retry until service restart): ${err.message}`)
        stopped = true
        if (timer) clearTimeout(timer)
        return
      }
      console.warn(`[discord embeddings] backfill failed: ${err instanceof Error ? err.message : String(err)}`)
      schedule(DISCORD_EMBEDDING_RETRY_MS)
    } finally {
      running = false
    }
  }

  if (!enabled || !embeddings) {
    if (!enabled) console.log("[discord embeddings] backfill disabled")
    return { stop: () => {} }
  }

  schedule(0)
  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

function keywordDiscordSearch(db: Database.Database, channelId: string, query: string, limit: number): Record<string, unknown>[] {
  const terms = query.split(/\s+/).map((term) => term.trim()).filter(Boolean).slice(0, 8)
  const pattern = `%${terms.join("%")}%`
  const rows = db.prepare<unknown[], DiscordSearchRow>(`select
     m.message_id, m.channel_id, m.guild_id, m.author_id, m.author_username,
     m.content, m.created_at, m.is_dm, m.mentions_bot, m.is_from_bot,
     c.guild_name, c.channel_name
   from discord_messages m
   left join discord_channels c on c.channel_id = m.channel_id
   where m.channel_id = ? and m.content like ?
   order by cast(m.message_id as integer) desc
   limit ?`).all(channelId, pattern, limit)
  return rows.map((row) => publicRow(db, row, { match: "keyword", semantic_similarity: 0 }))
}

async function semanticDiscordSearch(
  db: Database.Database,
  embeddings: DiscordEmbeddings | undefined,
  vecAvailable: () => boolean,
  channelId: string,
  query: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const skipped = discordEmbeddingUnavailableReason(embeddings, vecAvailable)
  if (skipped || !embeddings) return keywordDiscordSearch(db, channelId, query, limit)
  if (DISCORD_SEARCH_CATCHUP_BATCH_SIZE > 0) {
    await syncDiscordMessageEmbeddingsBatch(db, embeddings, vecAvailable, { channelId, limit: DISCORD_SEARCH_CATCHUP_BATCH_SIZE })
  }

  const [vector] = await embeddings.embedTexts([query])
  if (!vector || vector.length !== DISCORD_MEMORY_EMBEDDING_DIMENSIONS) return keywordDiscordSearch(db, channelId, query, limit)

  const rows = db.prepare<unknown[], DiscordSearchRow & { distance: number }>(`select
     m.message_id, m.channel_id, m.guild_id, m.author_id, m.author_username,
     m.content, m.created_at, m.is_dm, m.mentions_bot, m.is_from_bot,
     c.guild_name, c.channel_name,
     v.distance
   from discord_message_vec v
   join discord_messages m on m.message_id = cast(v.rowid as text)
   left join discord_channels c on c.channel_id = m.channel_id
   where v.embedding match ? and k = ?
   order by v.distance`).all(vectorParam(vector), Math.max(limit * 200, 1000))

  const results = rows
    .filter((row) => row.channel_id === channelId)
    .slice(0, limit)
    .map((row) => publicRow(db, row, {
      match: "semantic",
      semantic_distance: row.distance,
      semantic_similarity: 1 - row.distance,
    }))

  return results.length > 0 ? results : keywordDiscordSearch(db, channelId, query, limit)
}


function discordMemorySource(row: DiscordSearchRow): string {
  const location = row.is_dm === 1
    ? `DM ${row.channel_id}`
    : [row.guild_name ?? row.guild_id ?? "Discord", row.channel_name ? `#${row.channel_name}` : row.channel_id].join(" / ")
  const author = row.author_username ? `@${row.author_username}` : row.author_id ?? "unknown author"
  return `[discord] ${location} / ${author} / ${formatHumanTimestamp(row.created_at)}`
}

function keywordDiscordMemorySearch(db: Database.Database, query: string, limit: number, runtimeKind: RuntimeKind): DiscordMemorySearchResult[] {
  const terms = query.split(/\s+/).map((term) => term.trim()).filter(Boolean).slice(0, 8)
  if (terms.length === 0) return []
  const rows = db.prepare<unknown[], DiscordSearchRow>(`select m.message_id, m.channel_id, m.guild_id, m.author_id, m.author_username, m.content, m.created_at, m.is_dm, m.mentions_bot, m.is_from_bot, c.guild_name, c.channel_name from discord_messages m left join discord_channels c on c.channel_id = m.channel_id where m.content like ? and not exists (select 1 from discord_memory_prunes p where p.message_id = m.message_id) order by cast(m.message_id as integer) desc limit ?`).all(`%${terms.join("%")}%`, Math.max(1, Math.min(10, Math.trunc(limit) || 5)))
  return filterDiscordRowsForRuntime(db, rows, runtimeKind).map((row) => ({
    id: `discord:${row.message_id}`, kind: "discord", messageId: row.message_id, channelId: row.channel_id,
    guildId: row.guild_id, guildName: row.guild_name, channelName: row.channel_name, authorId: row.author_id,
    authorUsername: row.author_username, createdAt: row.created_at, source: discordMemorySource(row), content: row.content,
    preview: normalizeText(row.content), semanticSimilarity: 0,
  }))
}

/** Search the global Discord vector index for model-facing long-term-memory results. */
export async function searchDiscordMemoryEntries(
  db: Database.Database,
  embeddings: DiscordEmbeddings | undefined,
  vecAvailable: () => boolean,
  query: string,
  limit: number,
  queryVector?: number[],
  runtimeKind: RuntimeKind = "main",
): Promise<DiscordMemorySearchResult[]> {
  const skipped = queryVector
    ? (!vecAvailable() ? "sqlite-vec unavailable" : null)
    : discordEmbeddingUnavailableReason(embeddings, vecAvailable)
  if (skipped || (!queryVector && !embeddings)) return keywordDiscordMemorySearch(db, query, limit, runtimeKind)
  if (DISCORD_SEARCH_CATCHUP_BATCH_SIZE > 0 && embeddings?.configured()) {
    await syncDiscordMessageEmbeddingsBatch(db, embeddings, vecAvailable, { limit: DISCORD_SEARCH_CATCHUP_BATCH_SIZE })
  }

  const vector = queryVector ?? (embeddings ? (await embeddings.embedTexts([query]))[0] : undefined)
  if (!vector || vector.length !== DISCORD_MEMORY_EMBEDDING_DIMENSIONS) return keywordDiscordMemorySearch(db, query, limit, runtimeKind)
  const boundedLimit = Math.max(1, Math.min(10, Math.trunc(limit) || 5))
  const rows = db.prepare<unknown[], DiscordSearchRow & { distance: number }>(`select
     m.message_id, m.channel_id, m.guild_id, m.author_id, m.author_username,
     m.content, m.created_at, m.is_dm, m.mentions_bot, m.is_from_bot,
     c.guild_name, c.channel_name,
     v.distance
   from discord_message_vec v
   join discord_messages m on m.message_id = cast(v.rowid as text)
   left join discord_channels c on c.channel_id = m.channel_id
   where v.embedding match ? and k = ?
     and not exists (
       select 1 from discord_memory_prunes p where p.message_id = m.message_id
     )
   order by v.distance`).all(vectorParam(vector), Math.max(boundedLimit * 4, 20))

  return filterDiscordRowsForRuntime(db, rows, runtimeKind)
    .filter((row) => 1 - row.distance >= MEMORY_SEMANTIC_MIN_SIMILARITY)
    .slice(0, boundedLimit)
    .map((row) => ({
      id: `discord:${row.message_id}`,
      kind: "discord",
      messageId: row.message_id,
      channelId: row.channel_id,
      guildId: row.guild_id,
      guildName: row.guild_name,
      channelName: row.channel_name,
      authorId: row.author_id,
      authorUsername: row.author_username,
      createdAt: row.created_at,
      source: discordMemorySource(row),
      content: row.content,
      preview: normalizeText(row.content),
      semanticSimilarity: 1 - row.distance,
    }))
}

export type MemoryPruneReason = "explicit_request" | "surfaced_incorrect" | "surfaced_stale"

/** Deletes one Discord message and its vector memory, retaining a marker against re-ingestion. */
export function pruneDiscordMemory(
  db: Database.Database,
  vecAvailable: () => boolean,
  id: string,
  reason: MemoryPruneReason,
  note?: string,
  runtimeKind: RuntimeKind = "main",
): Record<string, unknown> {
  const match = /^discord:([0-9]+)$/.exec(String(id ?? "").trim())
  if (!match) throw new Error("memory_prune only accepts a discord:<message_id> returned by memory_search")
  if (!["explicit_request", "surfaced_incorrect", "surfaced_stale"].includes(reason)) {
    throw new Error("invalid memory_prune reason")
  }

  const messageId = match[1]!
  const message = db.prepare<unknown[], { channel_id: string }>("select channel_id from discord_messages where message_id = ?").get(messageId)
  if (message) assertDiscordChannelAccess(db, message.channel_id, runtimeKind)
  const indexed = db.prepare<unknown[], { present: number }>("select 1 as present from discord_message_embedding_meta where message_id = ?").get(messageId)
  const prior = db.prepare<unknown[], { reason: string; note: string | null; pruned_at: string }>("select reason, note, pruned_at from discord_memory_prunes where message_id = ?").get(messageId)
  if (!message && !indexed && !prior) throw new Error(`Discord memory ${id} is not indexed or does not exist`)

  const cleanNote = String(note ?? "").trim() || null
  db.transaction(() => {
    db.prepare(`
      insert into discord_memory_prunes (message_id, reason, note, pruned_at)
      values (?, ?, ?, datetime('now'))
      on conflict(message_id) do nothing
    `).run(messageId, reason, cleanNote)
    if (vecAvailable()) db.prepare("delete from discord_message_vec where rowid = ?").run(BigInt(messageId))
    db.prepare("delete from discord_messages where message_id = ?").run(messageId)
  })()

  const saved = db.prepare<unknown[], { reason: string; note: string | null; pruned_at: string }>("select reason, note, pruned_at from discord_memory_prunes where message_id = ?").get(messageId)
  if (!saved) throw new Error(`Discord memory ${id} was pruned but its marker could not be read`)
  return {
    ok: true,
    id: `discord:${messageId}`,
    reason: saved.reason,
    note: saved.note,
    pruned_at: saved.pruned_at,
    already_pruned: Boolean(prior),
    discord_message_deleted: true,
  }
}

/**
 * Searches stored Discord messages by exact message id or semantic query.
 *
 * @param params - Channel plus either message id or query.
 * @returns Search result payload.
 */
export async function searchDiscordMessages(
  db: Database.Database,
  embeddings: DiscordEmbeddings | undefined,
  vecAvailable: () => boolean,
  params: {
    channelId: string
    query?: string
    messageId?: string
    limit?: number
    runtimeKind?: RuntimeKind
  },
): Promise<Record<string, unknown>> {
  const channelId = resolveDiscordChannelId(db, params.channelId)
  if (!channelId) throw new Error("channel_id is required")
  assertDiscordChannelAccess(db, channelId, params.runtimeKind)

  const messageId = String(params.messageId ?? "").trim()
  const query = String(params.query ?? "").trim()
  const limit = Math.max(1, Math.min(50, Math.trunc(params.limit ?? 10) || 10))

  if (messageId) {
    const row = getMessage(db, channelId, messageId)
    return {
      ok: true,
      channel_id: channelId,
      message_id: messageId,
      results: row ? [publicRow(db, row, { match: "message_id" })] : [],
    }
  }

  if (!query) throw new Error("query or message_id is required")

  const results = await semanticDiscordSearch(db, embeddings, vecAvailable, channelId, query, limit)
  return {
    ok: true,
    channel_id: channelId,
    query,
    results,
  }
}
