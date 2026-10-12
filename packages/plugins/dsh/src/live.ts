import type { StreamEvent, StreamIdentity, WorkerEvent } from "@nano/protocol"
import type Database from "better-sqlite3"
import {
  alignToTurn, encodeWindow, SessionEncoder, submittedText,
  type AssistantDetail, type MessageRow, type ModelSource, type WireEvent,
} from "./encoder"

/** DSH model stream chunk (`@deepseek-ai/dsh-llm` StreamChunk subset Nano produces). */
type StreamChunk =
  | { type: "block-start"; index: number; blockType: "text" | "reasoning" }
  | { type: "text-delta"; index: number; text: string }
  | { type: "reasoning-delta"; index: number; text: string }
  | { type: "block-end"; index: number; block: { type: "reasoning"; text: string } }

export type AttemptOutcome = { kind: "committed"; eventType: "assistant/message"; seq: number } | { kind: "abandoned" }

/** `session/follow` assistant-stream frame before a follower stamps its revision. */
export type AttemptFrame =
  | { type: "start"; attemptId: string; startedAfterSeq: number; turn: number; step: number }
  | { type: "chunk"; attemptId: string; index: number; time: number; chunk: StreamChunk }
  | { type: "end"; attemptId: string; index: number; outcome: AttemptOutcome }

export interface Follower {
  event(event: WireEvent): void
  frame(frame: AttemptFrame): void
}

export interface ActiveAttemptView {
  attemptId: string
  startedAfterSeq: number
  turn: number
  step: number
  nextIndex: number
  stream: { type: "chunk"; time: number; chunk: StreamChunk }[]
}

/** A dense, turn-aligned event window ending at the journal cursor it was cut at. */
export interface EventWindow {
  records: WireEvent[]
  hasMore: boolean
}

interface Attempt {
  readonly key: string
  readonly attemptId: string
  readonly startedAfterSeq: number
  readonly turn: number
  readonly step: number
  readonly chunks: { time: number; chunk: StreamChunk }[]
  block: number
  blockType: "text" | "reasoning" | undefined
  reasoning: string
  usage?: AssistantDetail["usage"]
  messageId?: number
  messageSeq?: number
}

interface RowRecord { id: number; convId: number; role: string; content: string; toolCalls: string | null; toolCallId: string | null; createdAt: string }

const MAIN_LANE = "c.source not like 'frontend:%'"
const ROW_COLUMNS = "m.id, m.convId, m.role, m.content, m.toolCalls, m.toolCallId, m.createdAt"
const ROW_FROM = `from messages m join conversations c on c.id = m.convId where ${MAIN_LANE}`
const BOOT_ROWS = 1000
const MAX_BUFFERED_EVENTS = 20_000
const MAX_DETAILS = 500

function toRow(record: RowRecord): MessageRow {
  let toolCalls: unknown
  if (record.toolCalls) {
    try { toolCalls = JSON.parse(record.toolCalls) } catch { toolCalls = undefined }
  }
  return {
    id: record.id, convId: record.convId, role: record.role, content: record.content, createdAt: record.createdAt,
    ...(toolCalls === undefined ? {} : { toolCalls }), ...(record.toolCallId === null ? {} : { toolCallId: record.toolCallId }),
  }
}

function identityKey(identity: StreamIdentity): string {
  return `${identity.conversationId}:${identity.step}:${identity.attempt}`
}

/** Index of the newest-to-oldest window covering `maxMessages` surface messages, moved back to a turn start. */
function windowStart(events: readonly WireEvent[], end: number, maxMessages: number): number {
  let start = end
  let messages = 0
  while (start > 0 && messages < maxMessages) {
    start -= 1
    if (events[start]!.surfaceOp) messages += 1
  }
  while (start > 0 && events[start]!.type !== "turn/start") start -= 1
  return start
}

/**
 * The main lane's live DSH session: a bounded tail of encoded durable events
 * plus the in-flight model attempt, fanned out to every `session/follow`.
 */
export class LiveSession {
  private readonly encoder: SessionEncoder
  /** Ascending main-lane row ids and the seq of each row's own first event. */
  private readonly rowIds: number[] = []
  private readonly rowStarts: number[] = []
  private events: WireEvent[] = []
  private attempt: Attempt | undefined
  private readonly details = new Map<number, AssistantDetail>()
  private readonly mainConversations = new Map<number, boolean>()
  private readonly followers = new Set<Follower>()
  private readonly statusListeners = new Set<(running: boolean, updatedAt: number) => void>()
  /** DSH prompts accepted but not yet seen as a durable user row, oldest first. */
  private readonly prompts: { requestId: string; text: string }[] = []
  /** Closers that follow an attempt's committed message, released after the attempt's `end` frame. */
  private held: WireEvent[] = []
  running: boolean
  updatedAt: number

  constructor(
    private readonly db: () => Database.Database,
    private readonly source: () => ModelSource,
    running: boolean,
  ) {
    this.running = false
    this.updatedAt = Date.now()
    this.encoder = new SessionEncoder(source, (id) => this.detailFor(id))
    // Number the whole main-lane history without loading message content.
    const metadata = this.db().prepare<unknown[], RowRecord>(
      `select m.id, m.convId, m.role, '' as content, m.toolCalls, m.toolCallId, m.createdAt ${ROW_FROM} order by m.id asc`,
    )
    let last: MessageRow | undefined
    for (const record of metadata.iterate()) {
      last = toRow(record)
      this.encoder.push(last)
      this.index(last.id)
    }
    const ended = running ? [] : this.encoder.finish(last ? Date.parse(last.createdAt) || Date.now() : Date.now())
    if (last) this.updatedAt = Date.parse(last.createdAt) || this.updatedAt
    // Materialize the newest window with content from the same numbering.
    const tail = alignToTurn(this.rows(`${ROW_FROM} order by m.id desc limit ?`, [BOOT_ROWS]).reverse())
    if (tail.length > 0) {
      this.events = encodeWindow(tail, undefined, this.startOf(tail[0]!.id), source, (id) => this.details.get(id))
      if (ended.length > 0) this.events.push(...ended)
      if (this.events.at(-1)?.seq !== this.encoder.cursor) {
        // The DSH view is optional; never take the worker down over it.
        console.error(`[dsh] session tail ends at ${String(this.events.at(-1)?.seq)} but the journal is at ${this.encoder.cursor}; serving no history`)
        this.events = []
      }
    }
    this.running = this.encoder.turn !== undefined
  }

  /** Remember a submitted prompt so its durable user row can settle the browser's echo. */
  expectPrompt(requestId: string, text: string): void {
    this.prompts.push({ requestId, text })
    if (this.prompts.length > 64) this.prompts.shift()
  }

  get cursor(): number {
    return this.encoder.cursor
  }

  follow(follower: Follower): () => void {
    this.followers.add(follower)
    return () => this.followers.delete(follower)
  }

  onStatus(listener: (running: boolean, updatedAt: number) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  /** Newest buffered window covering at least `maxMessages` surface messages, ending at the cursor. */
  snapshot(maxMessages: number): EventWindow & { activeAttempt?: ActiveAttemptView } {
    const start = windowStart(this.events, this.events.length, maxMessages)
    const attempt = this.attempt
    return {
      records: this.events.slice(start),
      hasMore: (this.events[start]?.seq ?? this.cursor + 1) > 0,
      ...(attempt && attempt.messageSeq === undefined ? {
        activeAttempt: {
          attemptId: attempt.attemptId, startedAfterSeq: attempt.startedAfterSeq, turn: attempt.turn, step: attempt.step,
          nextIndex: attempt.chunks.length, stream: attempt.chunks.map(({ time, chunk }) => ({ type: "chunk" as const, time, chunk })),
        },
      } : {}),
    }
  }

  /** Newest window ending exactly at `throughSeq` (journal repair). */
  through(throughSeq: number, maxMessages: number): EventWindow {
    const end = this.events.findIndex((event) => event.seq > throughSeq)
    const stop = end === -1 ? this.events.length : end
    if (stop === 0 || this.events[stop - 1]!.seq !== throughSeq) throw new Error(`dsh: cursor ${throughSeq} is outside the live window`)
    const start = windowStart(this.events, stop, maxMessages)
    return { records: this.events.slice(start, stop), hasMore: this.events[start]!.seq > 0 }
  }

  /**
   * Older history ending at `beforeSeq - 1`. Served from the live buffer when it
   * covers the cursor; otherwise re-encoded from the database with identical
   * numbering. Live-only events (a step opened by an attempt the operator then
   * interrupted) cannot be re-derived, so a re-encoded page that would not end
   * contiguously is withheld instead of sent.
   */
  before(beforeSeq: number, maxMessages: number): EventWindow {
    const buffered = this.events.findIndex((event) => event.seq === beforeSeq)
    if (buffered > 0) {
      const start = windowStart(this.events, buffered, maxMessages)
      return { records: this.events.slice(start, buffered), hasMore: this.events[start]!.seq > 0 }
    }
    let low = 0
    let high = this.rowStarts.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (this.rowStarts[middle]! < beforeSeq) low = middle + 1
      else high = middle
    }
    if (low === 0) return { records: [], hasMore: false }
    const boundary = low < this.rowIds.length ? this.rowIds[low] : undefined
    const limit = Math.max(1, Math.min(1000, maxMessages))
    const older = boundary === undefined
      ? this.rows(`${ROW_FROM} order by m.id desc limit ?`, [limit])
      : this.rows(`${ROW_FROM} and m.id < ? order by m.id desc limit ?`, [boundary, limit])
    const rows = alignToTurn(older.reverse())
    if (rows.length === 0) return { records: [], hasMore: false }
    const next = boundary === undefined ? undefined : this.rows(`${ROW_FROM} and m.id = ?`, [boundary])[0]
    const records = encodeWindow(rows, next, this.startOf(rows[0]!.id), this.source, (id) => this.details.get(id))
      .filter((event) => event.seq < beforeSeq)
    if (records.at(-1)?.seq !== beforeSeq - 1) {
      console.warn(`[dsh] history before seq ${beforeSeq} is not re-derivable in this process; withholding older pages`)
      return { records: [], hasMore: false }
    }
    return { records, hasMore: records[0]!.seq > 0 }
  }

  /** Durable worker outbox input. */
  acceptWorkerEvent(event: WorkerEvent): void {
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : undefined
    const conversationId = typeof payload?.conversationId === "number" ? payload.conversationId : undefined
    if (conversationId === undefined) return
    if (event.type === "conversation.started") {
      const main = typeof payload!.source === "string" && !payload!.source.startsWith("frontend:")
      this.mainConversations.set(conversationId, main)
      // Nano can stay awake while idle; DSH "running" follows open turns and attempts instead.
      return
    }
    if (!this.isMain(conversationId)) return
    if (event.type === "conversation.message" && typeof payload!.messageId === "number" && typeof payload!.role === "string") {
      const content = typeof payload!.content === "string" ? payload!.content : ""
      const prompt = payload!.role === "user" ? this.prompts.findIndex((entry) => entry.text === submittedText(content)) : -1
      const rpcId = prompt === -1 ? undefined : this.prompts.splice(prompt, 1)[0]!.requestId
      const row: MessageRow = {
        id: payload!.messageId, convId: conversationId, role: payload!.role, content,
        createdAt: typeof payload!.createdAt === "string" ? payload!.createdAt : event.createdAt,
        ...(payload!.toolCalls === undefined ? {} : { toolCalls: payload!.toolCalls }),
        ...(typeof payload!.toolCallId === "string" ? { toolCallId: payload!.toolCallId } : {}),
        ...(rpcId ? { rpcId } : {}),
      }
      const events = this.encoder.push(row)
      this.index(row.id)
      if (this.attempt?.messageId === row.id) {
        this.attempt.messageSeq = this.encoder.lastAssistantSeq
        // DSH settles an attempt before anything that follows its message: the client stages the
        // message until the attempt's `end` frame, and retires live rows at a later step/end.
        const split = events.findIndex((item) => item.seq > this.encoder.lastAssistantSeq)
        if (split !== -1) {
          this.publish(events.slice(0, split))
          this.held = events.slice(split)
          return
        }
      }
      this.publish(events)
      return
    }
    if (event.type === "conversation.ended") {
      this.publish(this.encoder.finish())
    }
  }

  /** Transient stream input; only identity-stamped main-lane frames participate. */
  acceptStreamEvent(event: StreamEvent): void {
    const identity = event.identity
    if (!identity || identity.runtimeKind !== "main") return
    if (event.type === "assistant-start") {
      if (this.attempt) this.endAttempt({ kind: "abandoned" })
      // DSH opens the step durably before the model streams into it.
      this.publish(this.encoder.openStepForAttempt())
      const position = this.encoder.nextAssistantPosition()
      const key = identityKey(identity)
      const attempt: Attempt = {
        key, attemptId: `nano-${key.replaceAll(":", "-")}`,
        startedAfterSeq: this.encoder.cursor, turn: position?.turn ?? 0, step: position?.step ?? 1,
        chunks: [], block: -1, blockType: undefined, reasoning: "",
      }
      this.attempt = attempt
      this.broadcast({ type: "start", attemptId: attempt.attemptId, startedAfterSeq: attempt.startedAfterSeq, turn: attempt.turn, step: attempt.step })
      this.notify()
      return
    }
    if (event.type === "interrupted") {
      if (this.attempt) this.endAttempt({ kind: "abandoned" })
      this.publish(this.encoder.interrupt())
      return
    }
    const attempt = this.attempt
    if (!attempt || identityKey(identity) !== attempt.key) return
    if (event.type === "text") {
      if (!event.text) return
      if (attempt.blockType !== "text") this.openBlock(attempt, "text")
      this.chunk(attempt, { type: "text-delta", index: attempt.block, text: event.text })
    } else if (event.type === "thinking") {
      if (!event.text) return
      this.openBlock(attempt, "reasoning")
      this.chunk(attempt, { type: "reasoning-delta", index: attempt.block, text: event.text })
      this.chunk(attempt, { type: "block-end", index: attempt.block, block: { type: "reasoning", text: event.text } })
      attempt.blockType = undefined
      attempt.reasoning += attempt.reasoning ? `\n\n${event.text}` : event.text
    } else if (event.type === "usage") {
      attempt.usage = {
        inputTokens: (event.promptTokens ?? 0) - (event.cachedPromptTokens ?? 0),
        outputTokens: event.completionTokens ?? 0,
        ...(event.totalTokens === undefined ? {} : { totalTokens: event.totalTokens }),
      }
    } else if (event.type === "assistant-end") {
      this.endAttempt(event.outcome === "committed" && attempt.messageSeq !== undefined
        ? { kind: "committed", eventType: "assistant/message", seq: attempt.messageSeq }
        : { kind: "abandoned" })
    }
  }

  private openBlock(attempt: Attempt, blockType: "text" | "reasoning"): void {
    attempt.block += 1
    attempt.blockType = blockType
    this.chunk(attempt, { type: "block-start", index: attempt.block, blockType })
  }

  private chunk(attempt: Attempt, chunk: StreamChunk): void {
    const time = Date.now()
    const index = attempt.chunks.length
    attempt.chunks.push({ time, chunk })
    this.broadcast({ type: "chunk", attemptId: attempt.attemptId, index, time, chunk })
  }

  private endAttempt(outcome: AttemptOutcome): void {
    const attempt = this.attempt
    if (!attempt) return
    this.attempt = undefined
    this.broadcast({ type: "end", attemptId: attempt.attemptId, index: attempt.chunks.length, outcome })
    this.publish([])
    this.notify()
  }

  /** Claims the open attempt for the assistant row being committed right now. */
  private detailFor(messageId: number): AssistantDetail | undefined {
    const known = this.details.get(messageId)
    if (known) return known
    const attempt = this.attempt
    if (!attempt || attempt.messageId !== undefined) return undefined
    attempt.messageId = messageId
    const detail: AssistantDetail = {
      ...(attempt.reasoning ? { reasoning: attempt.reasoning } : {}),
      stream: attempt.chunks.map(({ time, chunk }) => ({ type: "chunk", time, chunk })),
      ...(attempt.usage ? { usage: attempt.usage } : {}),
    }
    this.details.set(messageId, detail)
    if (this.details.size > MAX_DETAILS) this.details.delete(this.details.keys().next().value!)
    return detail
  }

  private index(id: number): void {
    this.rowIds.push(id)
    this.rowStarts.push(this.encoder.lastOwnStart)
  }

  private startOf(id: number): number {
    let low = 0
    let high = this.rowIds.length - 1
    while (low <= high) {
      const middle = (low + high) >>> 1
      const value = this.rowIds[middle]!
      if (value === id) return this.rowStarts[middle]!
      if (value < id) low = middle + 1
      else high = middle - 1
    }
    throw new Error(`dsh: row ${id} is not indexed`)
  }

  private publish(events: WireEvent[]): void {
    const batch = this.held.length > 0 ? [...this.held.splice(0), ...events] : events
    if (batch.length === 0) return
    this.events.push(...batch)
    if (this.events.length > MAX_BUFFERED_EVENTS) {
      let cut = this.events.length - MAX_BUFFERED_EVENTS
      while (cut < this.events.length && this.events[cut]!.type !== "turn/start") cut += 1
      this.events = this.events.slice(cut)
    }
    for (const event of batch) for (const follower of this.followers) follower.event(event)
    this.updatedAt = Math.max(this.updatedAt, batch.at(-1)!.time)
    this.notify()
  }

  private broadcast(frame: AttemptFrame): void {
    for (const follower of this.followers) follower.frame(frame)
  }

  private notify(): void {
    this.running = this.encoder.turn !== undefined || this.attempt !== undefined
    for (const listener of this.statusListeners) listener(this.running, this.updatedAt)
  }

  private isMain(conversationId: number): boolean {
    const known = this.mainConversations.get(conversationId)
    if (known !== undefined) return known
    const row = this.db().prepare<unknown[], { source: string }>("select source from conversations where id = ?").get(conversationId)
    const main = Boolean(row && !row.source.startsWith("frontend:"))
    this.mainConversations.set(conversationId, main)
    return main
  }

  private rows(fromClause: string, parameters: unknown[]): MessageRow[] {
    return this.db().prepare<unknown[], RowRecord>(`select ${ROW_COLUMNS} ${fromClause}`).all(...parameters).map(toRow)
  }
}
