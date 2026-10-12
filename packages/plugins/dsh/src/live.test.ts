import assert from "node:assert/strict"
import test from "node:test"
import Database from "better-sqlite3"
import type { StreamEvent, StreamIdentity, WorkerEvent } from "@nano/protocol"
import { encodeWindow, type MessageRow, type WireEvent } from "./encoder"
import { LiveSession, type AttemptFrame } from "./live"

const source = () => ({ provider: "test", model: "test-model" })

function database(): Database.Database {
  const db = new Database(":memory:")
  db.exec(`
    create table conversations (id integer primary key, startedAt text not null, source text not null, tokens integer not null default 0);
    create table messages (id integer primary key, convId integer not null, role text not null, content text not null, toolCalls text, toolCallId text, createdAt text not null);
  `)
  return db
}

let clock = Date.parse("2026-10-01T00:00:00.000Z")
const at = () => new Date(clock += 1000).toISOString()

function insert(db: Database.Database, convId: number, role: string, content: string, extra: { toolCalls?: unknown; toolCallId?: string } = {}): MessageRow {
  const createdAt = at()
  const id = Number(db.prepare("insert into messages (convId, role, content, toolCalls, toolCallId, createdAt) values (?, ?, ?, ?, ?, ?)")
    .run(convId, role, content, extra.toolCalls ? JSON.stringify(extra.toolCalls) : null, extra.toolCallId ?? null, createdAt).lastInsertRowid)
  return { id, convId, role, content, createdAt, ...extra }
}

/** One Nano tool loop: prompt, tool-calling reply, tool result, final reply. */
function seedTurn(db: Database.Database, convId: number, index: number): void {
  const callId = `call-${index}`
  insert(db, convId, "user", `[incoming — chat]\n\nprompt ${index}`)
  insert(db, convId, "assistant", "checking", { toolCalls: [{ type: "toolCall", id: callId, name: "job_list", arguments: {} }] })
  insert(db, convId, "toolResult", "{\"jobs\":[]}", { toolCallId: callId })
  insert(db, convId, "assistant", `answer ${index}`)
}

function assertDense(events: readonly WireEvent[], label: string): void {
  events.forEach((event, index) => {
    if (index > 0) assert.equal(event.seq, events[index - 1]!.seq + 1, `${label}: seq ${event.seq} follows ${events[index - 1]!.seq}`)
  })
}

test("snapshot and history pages reassemble the same dense journal a single pass produces", () => {
  const db = database()
  for (let conversation = 1; conversation <= 3; conversation += 1) {
    db.prepare("insert into conversations (id, startedAt, source) values (?, ?, 'chat')").run(conversation, at())
    for (let turn = 0; turn < 5; turn += 1) seedTurn(db, conversation, conversation * 10 + turn)
  }
  db.prepare("insert into conversations (id, startedAt, source) values (4, ?, 'frontend:chat')").run(at())
  insert(db, 4, "user", "frontend lane traffic stays out of the main session")

  const session = new LiveSession(() => db, source, false)
  const snapshot = session.snapshot(4)
  assertDense(snapshot.records, "snapshot")
  assert.equal(snapshot.records.at(-1)!.seq, session.cursor, "snapshot ends at the journal cursor")
  assert.equal(snapshot.records[0]!.type, "turn/start", "snapshot window starts on a turn boundary")

  const journal = [...snapshot.records]
  let hasMore = snapshot.hasMore
  while (hasMore) {
    const page = session.before(journal[0]!.seq, 4)
    assert.ok(page.records.length > 0, "a page with more history is never empty")
    assert.equal(page.records.at(-1)!.seq, journal[0]!.seq - 1, "each page ends immediately before the window it extends")
    journal.unshift(...page.records)
    hasMore = page.hasMore
  }
  assertDense(journal, "reassembled journal")
  assert.equal(journal[0]!.seq, 0)

  const rows = db.prepare(`select m.id, m.convId, m.role, m.content, m.toolCalls, m.toolCallId, m.createdAt
    from messages m join conversations c on c.id = m.convId where c.source not like 'frontend:%' order by m.id`).all() as Array<MessageRow & { toolCalls: string | null; toolCallId: string | null }>
  const single = encodeWindow(rows.map((row) => ({
    ...row, ...(row.toolCalls ? { toolCalls: JSON.parse(row.toolCalls) } : { toolCalls: undefined }), toolCallId: row.toolCallId ?? undefined,
  })), undefined, 0, source)
  assert.deepEqual(journal.map((event) => `${event.seq}:${event.type}`), single.map((event) => `${event.seq}:${event.type}`))
  assert.equal(journal.filter((event) => event.type === "user/message").length, 15, "only main-lane turns are projected")
})

test("live attempts open their step first and settle before anything after their message", () => {
  const db = database()
  const session = new LiveSession(() => db, source, true)
  const timeline: string[] = []
  const frames: AttemptFrame[] = []
  const events: WireEvent[] = []
  session.follow({
    event: (event) => { events.push(event); timeline.push(`event ${event.type}`) },
    frame: (frame) => { frames.push(frame); timeline.push(`frame ${frame.type}`) },
  })
  let workerSeq = 0
  const worker = (type: WorkerEvent["type"], payload: Record<string, unknown>): void =>
    session.acceptWorkerEvent({ id: `w${workerSeq}`, agentId: "nano", seq: ++workerSeq, type, createdAt: at(), payload })
  const message = (row: MessageRow): void => worker("conversation.message", {
    conversationId: row.convId, messageId: row.id, role: row.role, content: row.content, createdAt: row.createdAt,
    ...(row.toolCalls ? { toolCalls: row.toolCalls } : {}), ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
  })
  const identity = (step: number): StreamIdentity => ({ runtimeKind: "main", conversationId: 1, step, attempt: 1 })
  const stream = (event: StreamEvent): void => session.acceptStreamEvent(event)

  db.prepare("insert into conversations (id, startedAt, source) values (1, ?, 'chat')").run(at())
  worker("conversation.started", { conversationId: 1, source: "chat", startedAt: at() })
  session.expectPrompt("rpc-1", "list jobs")
  message(insert(db, 1, "user", "[incoming — chat]\n\nlist jobs"))

  stream({ type: "assistant-start", identity: identity(1) })
  stream({ type: "text", text: "checking", identity: identity(1) })
  const toolCall = [{ type: "toolCall", id: "c1", name: "job_list", arguments: {} }]
  message(insert(db, 1, "assistant", "checking", { toolCalls: toolCall }))
  assert.equal(timeline.at(-1), "event assistant/message", "tool calls wait for the attempt to settle")
  stream({ type: "assistant-end", identity: identity(1), outcome: "committed" })
  message(insert(db, 1, "toolResult", "{\"jobs\":[]}", { toolCallId: "c1" }))

  stream({ type: "assistant-start", identity: identity(2) })
  stream({ type: "text", text: "partial", identity: identity(2) })
  stream({ type: "interrupted", identity: identity(2) })

  const user = events.find((event) => event.type === "user/message")!
  assert.deepEqual((user.data as { source: unknown; content: unknown }).source, { kind: "user", rpcId: "rpc-1" }, "the durable prompt settles the browser echo")
  assert.deepEqual((user.data as { content: unknown }).content, [{ type: "text", text: "list jobs" }], "Nano's delivery envelope is not shown")

  const [firstEnd, secondEnd] = frames.filter((frame) => frame.type === "end")
  const committedMessage = events.find((event) => event.type === "assistant/message")!
  assert.deepEqual(firstEnd!.type === "end" && firstEnd!.outcome, { kind: "committed", eventType: "assistant/message", seq: committedMessage.seq })
  assert.ok(timeline.indexOf("event tool/call") > timeline.indexOf("frame end"), "tool/call follows the committed end frame")
  assert.deepEqual(secondEnd!.type === "end" && secondEnd!.outcome, { kind: "abandoned" })

  const secondStart = timeline.lastIndexOf("frame start")
  assert.equal(timeline[secondStart - 1], "event step/start", "the follow-up attempt streams into an already-open step")
  assert.equal(timeline[secondStart - 2], "event step/end")

  const turnEnd = events.at(-1)!
  assert.equal(turnEnd.type, "turn/end")
  assert.deepEqual((turnEnd.data as { reason: unknown }).reason, { kind: "aborted", reason: { kind: "user" } })
  assertDense(events, "live journal")
  assert.equal(session.running, false, "an interrupted turn is no longer running")
  assert.equal(session.snapshot(500).records.at(-1)!.seq, session.cursor)
})
