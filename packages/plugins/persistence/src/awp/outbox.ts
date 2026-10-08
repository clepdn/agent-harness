import { randomUUID } from "crypto"
import type Database from "better-sqlite3"
import { AGENT_ID } from "@nano/runtime-api/agent-config"
import type { WorkerEvent, WorkerEventType } from "@nano/protocol"

type WorkerEventListener = (event: WorkerEvent) => void

export interface WorkerOutbox {
  publish(type: WorkerEventType, payload: unknown): WorkerEvent
  list(afterSeq?: number, limit?: number, mode?: "after" | "tail"): WorkerEvent[]
  subscribe(listener: WorkerEventListener): () => void
  bounds(): { oldestSeq: number; latestSeq: number }
}

const DEFAULT_REPLAY_TAIL_ROWS = 5000
const PRUNE_EVERY_PERSISTED_EVENTS = 100

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function shouldPersistWorkerEvent(type: WorkerEventType, payload: unknown): boolean {
  if (type === "worker.heartbeat") return false
  if (type === "metric.recorded") return isRecord(payload) && payload.type === "compaction"
  if (type === "stream.event") {
    return isRecord(payload) && (payload.type === "user" || payload.type === "usage")
  }
  return true
}

function decodeWorkerEvent(row: {
  seq: number
  id: string
  agent_id: string
  type: string
  payload: string
  created_at: string
}): WorkerEvent {
  let payload: unknown
  try {
    payload = JSON.parse(row.payload)
  } catch {
    payload = row.payload
  }
  return {
    id: row.id,
    agentId: row.agent_id,
    seq: row.seq,
    type: row.type as WorkerEventType,
    createdAt: row.created_at,
    payload,
  }
}

export function createWorkerOutbox(
  db: Database.Database,
  options: { agentId?: string; replayTailRows?: number } = {},
): WorkerOutbox {
  const agentId = options.agentId ?? AGENT_ID
  const configuredTail = options.replayTailRows ?? Number(process.env.AWP_REPLAY_TAIL_ROWS ?? DEFAULT_REPLAY_TAIL_ROWS)
  const tailRows = Number.isFinite(configuredTail) && configuredTail >= 0
    ? Math.trunc(configuredTail)
    : DEFAULT_REPLAY_TAIL_ROWS
  const listeners = new Set<WorkerEventListener>()
  let persistedSincePrune = 0

  const ensureTable = (): void => {
    db.exec(`
      create table if not exists worker_events (
        seq        integer primary key autoincrement,
        id         text    not null unique,
        agent_id   text    not null,
        type       text    not null,
        payload    text    not null,
        created_at text    not null
      );
      create index if not exists idx_worker_events_agent_seq
        on worker_events(agent_id, seq);
    `)
  }

  const prune = (): void => {
    if (tailRows === 0) {
      db.prepare("delete from worker_events").run()
      return
    }
    const row = db.prepare("select coalesce(max(seq), 0) as seq from worker_events").get() as { seq?: number }
    const cutoff = Math.max(0, Math.trunc(row.seq ?? 0) - tailRows)
    if (cutoff > 0) db.prepare("delete from worker_events where seq <= ?").run(cutoff)
  }

  const outbox: WorkerOutbox = {
    publish(type, payload) {
      const id = randomUUID()
      const createdAt = new Date().toISOString()
      let event: WorkerEvent = { id, agentId, seq: 0, type, createdAt, payload }
      if (shouldPersistWorkerEvent(type, payload)) {
        ensureTable()
        const result = db.prepare(
          "insert into worker_events (id, agent_id, type, payload, created_at) values (?, ?, ?, ?, ?)",
        ).run(id, agentId, type, JSON.stringify(payload), createdAt)
        event = { ...event, seq: Number(result.lastInsertRowid) }
        persistedSincePrune += 1
        if (persistedSincePrune >= PRUNE_EVERY_PERSISTED_EVENTS) {
          persistedSincePrune = 0
          prune()
        }
      }
      for (const listener of listeners) {
        try { listener(event) } catch (error) {
          console.error("[awp] worker event subscriber failed:", error)
        }
      }
      return event
    },
    list(afterSeq = 0, limit = 500, mode = "after") {
      ensureTable()
      const cappedLimit = Math.max(1, Math.min(1000, Math.trunc(limit) || 500))
      const rows = mode === "tail"
        ? db.prepare(`select seq, id, agent_id, type, payload, created_at
                      from worker_events order by seq desc limit ?`).all(cappedLimit).reverse()
        : db.prepare(`select seq, id, agent_id, type, payload, created_at
                      from worker_events where seq > ? order by seq asc limit ?`)
            .all(Math.max(0, Math.trunc(afterSeq) || 0), cappedLimit)
      return (rows as Array<{
        seq: number; id: string; agent_id: string; type: string; payload: string; created_at: string
      }>).map(decodeWorkerEvent)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    bounds() {
      ensureTable()
      const row = db.prepare(
        "select min(seq) as oldest, max(seq) as latest from worker_events",
      ).get() as { oldest?: number | null; latest?: number | null }
      return { oldestSeq: row.oldest ?? 0, latestSeq: row.latest ?? 0 }
    },
  }
  return outbox
}
