import assert from "node:assert/strict"
import test from "node:test"
import { createDatabase } from "../db"
import { createWorkerOutbox } from "./outbox"

test("outbox instances replay durable rows but never share live subscribers", (t) => {
  const firstDb = createDatabase(":memory:").db
  const secondDb = createDatabase(":memory:").db
  t.after(() => { firstDb.close(); secondDb.close() })
  const first = createWorkerOutbox(firstDb, { agentId: "first" })
  const second = createWorkerOutbox(secondDb, { agentId: "second" })
  const firstLive: number[] = []
  const secondLive: number[] = []
  first.subscribe((event) => firstLive.push(event.seq))
  second.subscribe((event) => secondLive.push(event.seq))

  const firstEvent = first.publish("runner.status", { presence: "awake" })
  const secondEvent = second.publish("runner.status", { presence: "resting" })
  assert.ok(firstEvent.seq > 0)
  assert.ok(secondEvent.seq > 0)
  assert.deepEqual(firstLive, [firstEvent.seq])
  assert.deepEqual(secondLive, [secondEvent.seq])
  assert.deepEqual(first.list().map((event) => event.payload), [{ presence: "awake" }])
  assert.deepEqual(second.list().map((event) => event.payload), [{ presence: "resting" }])
})

test("outbox keeps volatile live events out of durable replay", (t) => {
  const database = createDatabase(":memory:").db
  t.after(() => database.close())
  const outbox = createWorkerOutbox(database, { agentId: "test" })
  const delivered: number[] = []
  outbox.subscribe((event) => delivered.push(event.seq))

  const durableBefore = outbox.publish("runner.status", { presence: "awake" })
  const volatile = outbox.publish("worker.heartbeat", { alive: true })
  const durableAfter = outbox.publish("runner.status", { presence: "resting" })
  assert.ok(durableBefore.seq > 0)
  assert.equal(volatile.seq, 0)
  assert.equal(durableAfter.seq, durableBefore.seq + 1)
  assert.deepEqual(delivered, [durableBefore.seq, 0, durableAfter.seq])
  assert.deepEqual(outbox.list(0, 10).map((event) => event.seq), [durableBefore.seq, durableAfter.seq])
  assert.deepEqual(outbox.bounds(), { oldestSeq: durableBefore.seq, latestSeq: durableAfter.seq })
})

test("outbox prunes only its database tail and leaves sequence gaps visible", (t) => {
  const database = createDatabase(":memory:").db
  t.after(() => database.close())
  const outbox = createWorkerOutbox(database, { agentId: "test", replayTailRows: 2 })
  for (let index = 0; index < 100; index += 1) outbox.publish("runner.status", { index })
  const rows = outbox.list(0, 1000)
  assert.deepEqual(rows.map((event) => (event.payload as { index: number }).index), [98, 99])
  assert.ok(rows[0]!.seq > 1)
  assert.deepEqual(outbox.bounds(), { oldestSeq: rows[0]!.seq, latestSeq: rows[1]!.seq })
})
