import assert from "node:assert/strict"
import test from "node:test"
import { workerEvents, type WorkerEvent } from "@nano/protocol"
import { createRpcClient, type RpcSocket } from "./rpc.js"

class FakeSocket implements RpcSocket {
  static readonly instances: FakeSocket[] = []
  readonly url: string
  readonly sent: Array<Record<string, unknown>> = []
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  open(): void {
    this.readyState = 1
    this.onopen?.(new Event("open"))
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.(new Event("close") as unknown as CloseEvent)
  }

  deliver(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<unknown>)
  }
}

function event(seq: number, id: string): WorkerEvent {
  return {
    id,
    agentId: "agent",
    seq,
    type: "worker.heartbeat",
    createdAt: `2026-10-07T00:00:${String(seq).padStart(2, "0")}.000Z`,
    payload: { seq },
  }
}

function subscriptions(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.filter((candidate): candidate is Record<string, unknown> => candidate.op === "subscribe")
}

function streamId(socket: FakeSocket, index: number): string {
  const frame = subscriptions(socket)[index]
  assert.ok(frame && typeof frame.id === "string")
  return frame.id
}

function receivedSequence(value: unknown): number | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid received stream item")
  if ("value" in value && value.value && typeof value.value === "object" && !Array.isArray(value.value) && "seq" in value.value && typeof value.value.seq === "number") return value.value.seq
  if ("after" in value && typeof value.after === "number") return `gap:${value.after}`
  throw new Error("invalid received stream item")
}
async function microtasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

test("RPC streams reconnect and resume each worker cursor independently", async () => {
  FakeSocket.instances.length = 0
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const scheduled: Array<() => void> = []
  globalThis.setTimeout = ((callback: TimerHandler) => {
    const task: () => void = typeof callback === "function" ? callback as () => void : () => {}
    scheduled.push(task)
    return scheduled.length as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = (() => {}) as unknown as typeof clearTimeout

  const firstItems: unknown[] = []
  const secondItems: unknown[] = []
  const client = createRpcClient({
    url: "http://worker.test",
    WebSocketImpl: FakeSocket,
  })
  try {
    const firstPromise = client.stream(workerEvents, { afterSeq: 10 }, { onItem: (value) => firstItems.push(value) })
    const secondPromise = client.stream(workerEvents, { afterSeq: 20 }, { onItem: (value) => secondItems.push(value) })
    assert.equal(FakeSocket.instances.length, 1)
    const firstSocket = FakeSocket.instances[0]!
    assert.equal(firstSocket.url, "ws://worker.test/rpc/stream")
    firstSocket.open()
    await microtasks()
    const firstId = streamId(firstSocket, 0)
    const secondId = streamId(firstSocket, 1)
    assert.equal(firstSocket.sent.filter((candidate) => candidate.op === "subscribe").length, 2)
    firstSocket.deliver({ id: firstId, op: "item", value: { seq: 11, volatile: false, value: event(11, "first-11") } })
    firstSocket.deliver({ id: firstId, op: "item", value: { seq: 11, volatile: false, value: event(11, "first-11-duplicate") } })
    firstSocket.deliver({ id: firstId, op: "item", value: { seq: 0, volatile: true, value: event(0, "first-volatile") } })
    firstSocket.deliver({ id: firstId, op: "item", value: { seq: 12, volatile: false, value: event(12, "first-12") } })
    firstSocket.deliver({ id: secondId, op: "item", value: { seq: 21, volatile: false, value: event(21, "second-21") } })
    await microtasks()
    firstSocket.close()
    assert.equal(scheduled.length, 1)

    scheduled.shift()!()
    await microtasks()
    assert.equal(FakeSocket.instances.length, 2)
    const resumedSocket = FakeSocket.instances[1]!
    resumedSocket.open()
    await microtasks()
    const resumed = subscriptions(resumedSocket)
    assert.equal(resumed.length, 2)
    assert.deepEqual(resumed.map((candidate) => candidate.input), [{ afterSeq: 12 }, { afterSeq: 21 }])
    assert.deepEqual(resumed.map((candidate) => candidate.id), [firstId, secondId])

    resumedSocket.deliver({ id: firstId, op: "item", value: { after: 11, availableFrom: 15, latest: 20 } })
    resumedSocket.deliver({ id: secondId, op: "item", value: { seq: 22, volatile: false, value: event(22, "second-22") } })
    resumedSocket.close()
    assert.equal(scheduled.length, 1)
    scheduled.shift()!()
    await microtasks()
    assert.equal(FakeSocket.instances.length, 3)
    const finalSocket = FakeSocket.instances[2]!
    finalSocket.open()
    await microtasks()
    const finalSubscriptions = subscriptions(finalSocket)
    assert.equal(finalSubscriptions.length, 2)
    finalSocket.deliver({ id: firstId, op: "item", value: { seq: 21, volatile: false, value: event(21, "first-21") } })
    finalSocket.deliver({ id: secondId, op: "item", value: { seq: 23, volatile: false, value: event(23, "second-23") } })
    finalSocket.deliver({ id: firstId, op: "end" })
    finalSocket.deliver({ id: secondId, op: "end" })
    await Promise.all([firstPromise, secondPromise])
    assert.deepEqual(firstItems.map(receivedSequence), [11, 0, 12, "gap:11", 21])
    assert.deepEqual(secondItems.map(receivedSequence), [21, 22, 23])
  } finally {
    client.close()
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})

test("RPC reconnect keeps one stream error isolated from another", async () => {
  FakeSocket.instances.length = 0
  const scheduled: Array<() => void> = []
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const client = createRpcClient({ url: "http://worker.test", WebSocketImpl: FakeSocket })
  globalThis.setTimeout = ((callback: TimerHandler) => {
    scheduled.push(typeof callback === "function" ? callback as () => void : () => {})
    return scheduled.length as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = (() => {}) as unknown as typeof clearTimeout
  try {
    const failed = client.stream(workerEvents, { afterSeq: 1 }, { onItem: () => {} })
    const survives = client.stream(workerEvents, { afterSeq: 2 }, { onItem: () => {} })
    const initial = FakeSocket.instances[0]!
    initial.open()
    await microtasks()
    const failedId = streamId(initial, 0)
    const survivesId = streamId(initial, 1)
    initial.deliver({ id: failedId, op: "item", value: { seq: 2, volatile: false, value: event(2, "failed-2") } })
    initial.close()
    scheduled.shift()!()
    await microtasks()
    const resumed = FakeSocket.instances[1]!
    resumed.open()
    await microtasks()
    resumed.deliver({ id: failedId, op: "error", error: { code: "UNAVAILABLE", message: "replay window expired" } })
    resumed.deliver({ id: survivesId, op: "item", value: { seq: 3, volatile: false, value: event(3, "survives-3") } })
    resumed.deliver({ id: survivesId, op: "end" })
    await assert.rejects(failed, (error: unknown) => error instanceof Error && "code" in error && error.code === "UNAVAILABLE")
    await survives
  } finally {
    client.close()
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})
