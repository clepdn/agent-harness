import Database from "better-sqlite3"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentRecord, WorkerEvent } from "@nano/protocol"
export type { AgentRecord, WorkerEvent }

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
const DEFAULT_CONTROL_HOME = path.resolve(process.env.NANO_CONTROL_HOME ?? path.join(REPO_ROOT, "data", "control"))
const DEFAULT_CONTROL_DB_PATH = path.resolve(process.env.NANO_CONTROL_DB ?? path.join(DEFAULT_CONTROL_HOME, "control.db"))
const DEFAULT_REPLAY_TAIL_ROWS = 5000
const PRUNE_EVERY_RECORDED_EVENTS = 100

/* Agent metadata is the shared protocol record; persistence only translates
 * snake_case database rows at the boundary. */

type AgentRow = {
  id: string
  name: string
  base_url: string
  status: string
  last_seen_at: string | null
  last_seq: number
}

export type MirroredCompaction = {
  agentId: string
  seq: number
  eventId: string
  metricId?: number
  timestamp: string
  method?: string
  before?: number
  after?: number
  savedTokens?: number
  summary?: string
}

export type WorkerEventRecord = WorkerEvent

export class ControlStore {
  private database: Database.Database | null = null
  private readonly recordedSincePruneByAgent = new Map<string, number>()

  constructor(readonly databasePath = DEFAULT_CONTROL_DB_PATH) {}

  initialize(): void {
    if (this.database) return
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 })
    fs.chmodSync(path.dirname(this.databasePath), 0o700)
    this.database = new Database(this.databasePath)
    fs.chmodSync(this.databasePath, 0o600)
    this.database.pragma("journal_mode = WAL")
    this.database.exec(`
      create table if not exists agents (
        id           text primary key,
        name         text not null,
        base_url     text not null,
        status       text not null default 'unknown',
        last_seen_at text,
        last_seq     integer not null default 0,
        created_at   text not null default (datetime('now')),
        updated_at   text not null default (datetime('now'))
      );

      create table if not exists worker_events (
        agent_id   text    not null,
        seq        integer not null,
        id         text    not null,
        type       text    not null,
        payload    text    not null,
        created_at text    not null,
        received_at text   not null,
        primary key (agent_id, seq)
      );

      create unique index if not exists idx_worker_events_id
        on worker_events(agent_id, id);
      create index if not exists idx_worker_events_type
        on worker_events(type, received_at desc);
    `)
  }

  close(): void {
    if (!this.database) return
    this.database.close()
    this.database = null
    this.recordedSincePruneByAgent.clear()
  }

  upsertAgent(input: { id: string; name?: string; baseUrl: string }): AgentRecord {
    const id = input.id.trim()
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, "")
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("agent id must contain only letters, numbers, underscores, or hyphens")
    if (!baseUrl) throw new Error("agent baseUrl is required")
    const parsedUrl = new URL(baseUrl)
    if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
      throw new Error("agent baseUrl must be an HTTP(S) URL without embedded credentials")
    }

    const name = input.name?.trim() || id
    this.db().prepare(
      `insert into agents (id, name, base_url, status, updated_at)
       values (?, ?, ?, 'unknown', ?)
       on conflict(id) do update set
         name = excluded.name,
         base_url = excluded.base_url,
         updated_at = excluded.updated_at`,
    ).run(id, name, baseUrl, new Date().toISOString())
    return this.getAgent(id)!
  }

  listAgents(): AgentRecord[] {
    const rows = this.db()
      .prepare("select id, name, base_url, status, last_seen_at, last_seq from agents order by id asc")
      .all() as AgentRow[]
    return rows.map(agentFromRow)
  }

  getAgent(id: string): AgentRecord | null {
    const row = this.db()
      .prepare("select id, name, base_url, status, last_seen_at, last_seq from agents where id = ?")
      .get(id) as AgentRow | undefined
    return row ? agentFromRow(row) : null
  }

  updateAgentStatus(id: string, status: string, lastSeq?: number): void {
    const now = new Date().toISOString()
    this.db().prepare(
      `update agents
       set status = ?,
           last_seen_at = ?,
           last_seq = max(last_seq, ?),
           updated_at = ?
       where id = ?`,
    ).run(status, now, Math.max(0, Math.trunc(lastSeq ?? 0)), now, id)
  }

  recordWorkerEvent(event: WorkerEventRecord): void {
    const receivedAt = new Date().toISOString()
    this.db().prepare(
      `insert or ignore into worker_events (agent_id, seq, id, type, payload, created_at, received_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    ).run(event.agentId, event.seq, event.id, event.type, JSON.stringify(event.payload), event.createdAt, receivedAt)
    this.updateAgentStatus(event.agentId, "online", event.seq)

    const recordedSincePrune = (this.recordedSincePruneByAgent.get(event.agentId) ?? 0) + 1
    if (recordedSincePrune >= PRUNE_EVERY_RECORDED_EVENTS) {
      this.recordedSincePruneByAgent.set(event.agentId, 0)
      this.pruneMirroredEvents(event.agentId)
    } else {
      this.recordedSincePruneByAgent.set(event.agentId, recordedSincePrune)
    }
  }

  listMirroredEvents(agentId: string, afterSeq = 0, limit = 500, mode: "after" | "tail" = "after"): unknown[] {
    const cappedLimit = Math.max(1, Math.min(1000, Math.trunc(limit) || 500))
    const rows = mode === "tail"
      ? this.db()
          .prepare(
            `select agent_id, seq, id, type, payload, created_at
             from worker_events where agent_id = ? order by seq desc limit ?`,
          )
          .all(agentId, cappedLimit)
          .reverse()
      : this.db()
          .prepare(
            `select agent_id, seq, id, type, payload, created_at
             from worker_events where agent_id = ? and seq > ? order by seq asc limit ?`,
          )
          .all(agentId, Math.max(0, Math.trunc(afterSeq) || 0), cappedLimit)

    return (rows as Array<{
      agent_id: string
      seq: number
      id: string
      type: string
      payload: string
      created_at: string
    }>).map((row) => ({
      agentId: row.agent_id,
      seq: row.seq,
      id: row.id,
      type: row.type,
      createdAt: row.created_at,
      payload: parseJsonOrText(row.payload),
    }))
  }

  listRecentCompactions(agentId: string, limit = 20): MirroredCompaction[] {
    const cappedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 20))
    const rows = this.db()
      .prepare(
        `select agent_id, seq, id, payload, created_at
         from worker_events
         where agent_id = ? and type = 'metric.recorded'
         order by seq desc limit 500`,
      )
      .all(agentId) as Array<{
      agent_id: string
      seq: number
      id: string
      payload: string
      created_at: string
    }>

    const compactions: MirroredCompaction[] = []
    for (const row of rows) {
      const payload = parseJsonOrText(row.payload)
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue
      const data = payload as Record<string, unknown>
      if (data.type !== "compaction") continue
      const before = typeof data.before === "number" ? data.before : undefined
      const after = typeof data.after === "number" ? data.after : undefined
      compactions.push({
        agentId: row.agent_id,
        seq: row.seq,
        eventId: row.id,
        metricId: typeof data.id === "number" ? data.id : undefined,
        timestamp: typeof data.timestamp === "string" ? data.timestamp : row.created_at,
        method: typeof data.method === "string" ? data.method : undefined,
        before,
        after,
        savedTokens: before !== undefined && after !== undefined ? before - after : undefined,
        summary: typeof data.summary === "string" ? data.summary : undefined,
      })
      if (compactions.length >= cappedLimit) break
    }
    return compactions
  }

  private db(): Database.Database {
    if (!this.database) throw new Error("control store is not initialized")
    return this.database
  }

  private pruneMirroredEvents(agentId: string): void {
    const parsed = Number(process.env.AWP_REPLAY_TAIL_ROWS ?? DEFAULT_REPLAY_TAIL_ROWS)
    const tailRows = !Number.isFinite(parsed) || parsed < 0 ? DEFAULT_REPLAY_TAIL_ROWS : Math.trunc(parsed)
    if (tailRows <= 0) {
      this.db().prepare("delete from worker_events where agent_id = ?").run(agentId)
      return
    }
    const row = this.db().prepare("select coalesce(max(seq), 0) as seq from worker_events where agent_id = ?").get(agentId) as { seq?: number }
    const cutoff = Math.max(0, Math.trunc(row.seq ?? 0) - tailRows)
    if (cutoff > 0) this.db().prepare("delete from worker_events where agent_id = ? and seq <= ?").run(agentId, cutoff)
  }
}

function agentFromRow(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    status: row.status,
    ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at } : {}),
    lastSeq: row.last_seq,
  }
}

function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
