/**
 * Deterministic projection of Nano's main-lane message rows onto the DeepSeek
 * Harness durable session vocabulary.
 *
 * DSH journals are dense: every event's `seq` is exactly one past the
 * previous event's. The encoder numbers events from a running counter, so a
 * window that starts on a turn boundary can be re-encoded from the row's
 * recorded start seq and reproduce the live numbering exactly. Closers that a
 * later row triggers (`step/end`, `turn/end`) occupy the seqs immediately
 * before that row's own events.
 */

export interface MessageRow {
  readonly id: number
  readonly convId: number
  readonly role: string
  readonly content: string
  readonly toolCalls?: unknown
  readonly toolCallId?: string
  readonly createdAt: string
  /** DSH `session/prompt` request that produced this user row, when known to the live process. */
  readonly rpcId?: string
}

/** Nano's delivery envelope on a user turn (`[incoming — chat]`, `[harness restarted — chat @ …]`). */
const NANO_ENVELOPE = /^\[(?:incoming|harness restarted|frontend harness restarted) — [^\]\n]*\]\n\n/

/** The text a person submitted, without the delivery envelope Nano adds for the model. */
export function submittedText(content: string): string {
  return content.replace(NANO_ENVELOPE, "")
}

export interface WireEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly surfaceOp?: "append"
}

export interface ModelSource {
  readonly provider: string
  readonly model: string
}

/** Extra presentation detail known only to the live process for one assistant row. */
export interface AssistantDetail {
  readonly reasoning?: string
  readonly stream?: readonly unknown[]
  readonly usage?: { inputTokens: number; outputTokens: number; totalTokens?: number }
}

interface ToolCallLike { id: string; name: string; arguments: unknown }

function toolCallsOf(value: unknown): ToolCallLike[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((call) => {
    if (!call || typeof call !== "object") return []
    const record = call as Record<string, unknown>
    if (typeof record.id !== "string" || typeof record.name !== "string") return []
    return [{ id: record.id, name: record.name, arguments: record.arguments }]
  })
}

function argumentsText(value: unknown): string {
  if (typeof value === "string") return value
  try { return JSON.stringify(value ?? {}) } catch { return "{}" }
}

export class SessionEncoder {
  turn: number | undefined
  step = 0
  stepOpen = false
  stepHasAssistant = false
  convId: number | undefined
  /** Seq of the first event the most recent `push` emitted for the row itself (after closers). */
  lastOwnStart = -1
  /** Seq of the newest emitted `assistant/message`. */
  lastAssistantSeq = -1

  constructor(
    private readonly source: () => ModelSource,
    private readonly detail: (messageId: number) => AssistantDetail | undefined = () => undefined,
    private nextSeq = 0,
  ) {}

  /** Seq of the newest emitted event, or -1 before any. */
  get cursor(): number {
    return this.nextSeq - 1
  }

  /** Turn and step that the next assistant row will occupy, when a turn is open. */
  nextAssistantPosition(): { turn: number; step: number } | undefined {
    if (this.turn === undefined) return undefined
    return { turn: this.turn, step: this.stepOpen && !this.stepHasAssistant ? this.step : this.step + 1 }
  }

  /** Close the open step/turn the given row supersedes, then encode the row. */
  push(row: MessageRow): WireEvent[] {
    const out = this.closeBefore(row)
    this.lastOwnStart = this.nextSeq
    out.push(...this.open(row))
    this.convId = row.convId
    return out
  }

  /** Emit only the closers `next` would trigger (used at the end of a history window). */
  closeFor(next: MessageRow): WireEvent[] {
    return this.closeBefore(next)
  }

  /** Close everything after the conversation ended. */
  finish(time = Date.now()): WireEvent[] {
    return this.close(true, true, time)
  }

  /** Close the open turn as stopped by the operator. */
  interrupt(time = Date.now()): WireEvent[] {
    return this.close(true, true, time, "aborted")
  }

  /**
   * Open the step a starting model attempt will fill, so its live output never
   * precedes its `step/start`. Emits exactly the closers and `step/start` the
   * assistant row would emit, which then emits none of its own.
   */
  openStepForAttempt(time = Date.now()): WireEvent[] {
    if (this.turn === undefined || (this.stepOpen && !this.stepHasAssistant)) return []
    const out = this.stepOpen ? this.close(true, false, time) : []
    this.step += 1
    this.stepOpen = true
    this.stepHasAssistant = false
    out.push(this.emit("step/start", time, { turn: this.turn, step: this.step }))
    return out
  }

  private emit(type: string, time: number, data: unknown, surface = false): WireEvent {
    const event: WireEvent = { type, seq: this.nextSeq++, time, data, ...(surface ? { surfaceOp: "append" as const } : {}) }
    if (type === "assistant/message") this.lastAssistantSeq = event.seq
    return event
  }

  private closeBefore(row: MessageRow): WireEvent[] {
    const time = Date.parse(row.createdAt) || 0
    if (this.convId !== undefined && row.convId !== this.convId) return this.close(true, true, time)
    if (row.role === "user") return this.close(true, true, time)
    if (row.role === "assistant" && this.stepOpen && this.stepHasAssistant) return this.close(true, false, time)
    return []
  }

  private close(step: boolean, turn: boolean, time: number, reason: "completed" | "aborted" = "completed"): WireEvent[] {
    if (this.turn === undefined) return []
    const out: WireEvent[] = []
    if (step && this.stepOpen) {
      out.push(this.emit("step/end", time, { turn: this.turn, step: this.step }))
      this.stepOpen = false
      this.stepHasAssistant = false
    }
    if (turn) {
      out.push(this.emit("turn/end", time, { turn: this.turn, reason: reason === "aborted" ? { kind: "aborted", reason: { kind: "user" } } : { kind: "completed" } }))
      this.turn = undefined
      this.step = 0
    }
    return out
  }

  private open(row: MessageRow): WireEvent[] {
    const time = Date.parse(row.createdAt) || 0
    const out: WireEvent[] = []
    if (row.role === "user") {
      this.turn = row.id
      this.step = 1
      this.stepOpen = true
      this.stepHasAssistant = false
      out.push(this.emit("turn/start", time, { turn: this.turn }))
      out.push(this.emit("step/start", time, { turn: this.turn, step: 1 }))
      out.push(this.emit("user/message", time, {
        id: `nano-${row.id}`, role: "user", source: { kind: "user", ...(row.rpcId ? { rpcId: row.rpcId } : {}) },
        content: [{ type: "text", text: submittedText(row.content) }],
      }, true))
      return out
    }
    if (row.role === "assistant") {
      if (this.turn === undefined) {
        this.turn = row.id
        this.step = 0
        out.push(this.emit("turn/start", time, { turn: this.turn }))
      }
      if (!this.stepOpen) {
        this.step += 1
        this.stepOpen = true
        out.push(this.emit("step/start", time, { turn: this.turn, step: this.step }))
      }
      this.stepHasAssistant = true
      const calls = toolCallsOf(row.toolCalls)
      const detail = this.detail(row.id)
      const content: unknown[] = []
      if (detail?.reasoning) content.push({ type: "reasoning", text: detail.reasoning })
      if (row.content) content.push({ type: "text", text: row.content })
      for (const call of calls) content.push({ type: "tool-call", id: call.id, name: call.name, arguments: argumentsText(call.arguments) })
      const { provider, model } = this.source()
      out.push(this.emit("assistant/message", time, {
        turn: this.turn, step: this.step,
        message: { id: `nano-${row.id}`, role: "assistant", source: { kind: "model", provider, model }, content },
        stream: detail?.stream ?? [],
        ...(detail?.usage ? { usage: detail.usage } : {}),
      }, true))
      for (const call of calls) {
        out.push(this.emit("tool/call", time, { turn: this.turn, step: this.step, callId: call.id, name: call.name, arguments: argumentsText(call.arguments) }))
      }
      // A reply without tool calls hands control back: the turn is complete even while Nano stays awake.
      if (calls.length === 0) out.push(...this.close(true, true, time))
      return out
    }
    if ((row.role === "toolResult" || row.role === "tool") && row.toolCallId && this.turn !== undefined && this.stepOpen) {
      out.push(this.emit("tool/result", time, {
        turn: this.turn, step: this.step,
        message: {
          id: `nano-${row.id}`, role: "tool", source: { kind: "tool", callId: row.toolCallId }, toolCallId: row.toolCallId,
          content: [{ type: "text", text: row.content }], ...(row.content.startsWith("error:") ? { isError: true } : {}),
        },
      }, true))
    }
    return out
  }
}

/**
 * Encode a contiguous turn-aligned row window starting at `startSeq`; `next`
 * is the first row after it, whose closers end the window.
 */
export function encodeWindow(
  rows: readonly MessageRow[],
  next: MessageRow | undefined,
  startSeq: number,
  source: () => ModelSource,
  detail?: (messageId: number) => AssistantDetail | undefined,
): WireEvent[] {
  const encoder = new SessionEncoder(source, detail, startSeq)
  const out: WireEvent[] = []
  for (const row of rows) out.push(...encoder.push(row))
  if (next) out.push(...encoder.closeFor(next))
  return out
}

/** Drop leading rows until the window starts on a user turn, unless none exists. */
export function alignToTurn(rows: readonly MessageRow[]): readonly MessageRow[] {
  const start = rows.findIndex((row) => row.role === "user")
  return start <= 0 ? rows : rows.slice(start)
}
