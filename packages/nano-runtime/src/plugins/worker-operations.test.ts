import assert from "node:assert/strict"
import test from "node:test"
import { PluginBus, type Plugin, type PluginScope } from "@nano/plugins"
import { workerAwpEnqueue, workerEvents, workerStatus } from "@nano/protocol"
import { nano, type LifecycleService, type RunnerService } from "./api"
import { workerOperationsPlugin } from "./worker-operations"
import { createPersistencePlugin } from "./persistence"
import { mkdtemp, rm } from "node:fs/promises"

function fakeRunner(): RunnerService {
  return {
    activate() {},
    wake: async () => {},
    enqueue: () => true,
    status: () => ({ agentId: "fake-worker", running: false, idle: true, tokenCount: 0, contextSize: 1000, processStartedAt: "2026-01-01T00:00:00.000Z", uptimeMs: 1 }),
    interrupt: () => "idle",
    discard: () => true,
    rest: () => true,
    compact: () => true,
    swapModel: async (preset) => ({ preset, model: "fake", provider: "fake", graceful: true }),
    modelSnapshot: () => ({ primary: null, fallback: { id: "fake", provider: "fake", baseUrl: "https://fake.invalid" }, respectPromptCache: true, useFallback: false, enableThinking: false, thinkingEffort: "none", vision: false }),
    trigger: async (source) => ({ ok: true, source }),
  }
}

const fakeLifecycle: LifecycleService = { shutdown() {}, restart() {} }

function providerPlugin(runner: RunnerService, lifecycle: LifecycleService): Plugin {
  return {
    id: "fake-worker-services",
    provides: [nano.runner, nano.lifecycle],
    apply(scope: PluginScope) {
      scope.provide(nano.runner, runner)
      scope.provide(nano.lifecycle, lifecycle)
    },
  }
}

function operation(bus: PluginBus, name: string) {
  const contribution = bus.list(nano.operations).find((entry) => entry.key === name)
  assert.ok(contribution, `missing operation ${name}`)
  return contribution.value
}

test("worker operations are public service bindings and unload with their owner", async () => {
  const bus = new PluginBus()
  await bus.install(providerPlugin(fakeRunner(), fakeLifecycle))
  await bus.install(workerOperationsPlugin)
  const context = { signal: new AbortController().signal, subject: "test" }
  const status = workerStatus.output.parse(await operation(bus, workerStatus.name).handler({}, context))
  assert.equal(status.agentId, "fake-worker")
  assert.equal(status.idle, true)
  const enqueue = await operation(bus, workerAwpEnqueue.name).handler({
    event: { source: "chat", triggeredAt: "2026-01-01T00:00:00.000Z", content: "hello", raw: null },
  }, context)
  assert.deepEqual(enqueue, { ok: true, running: false })
  await bus.disable(workerOperationsPlugin.id)
  assert.equal(bus.list(nano.operations).some((entry) => entry.key === workerStatus.name), false)
  await bus.close()
})

test("worker operation callbacks fail closed when an optional service is absent", async () => {
  const bus = new PluginBus()
  await bus.install(providerPlugin(fakeRunner(), fakeLifecycle))
  await bus.install(workerOperationsPlugin)
  const events = operation(bus, "worker.events.list")
  await assert.rejects(async () => { await events.handler({}, { signal: new AbortController().signal, subject: "test" }) }, /nano\.persistence service is unavailable/)
  await bus.close()
})

test("cancelling an idle worker stream settles next without another published event", async (t) => {
  const home = await mkdtemp("/tmp/nano-worker-stream-")
  const bus = new PluginBus()
  t.after(async () => { await bus.close(); await rm(home, { recursive: true, force: true }) })
  await bus.install(createPersistencePlugin({ home, path: ":memory:" }))
  await bus.install(providerPlugin(fakeRunner(), fakeLifecycle))
  await bus.install(workerOperationsPlugin)
  const stream = bus.list(nano.streams).find((entry) => entry.key === workerEvents.name)
  assert.ok(stream)
  const controller = new AbortController()
  const source = await stream.value.handler({}, { signal: controller.signal, subject: "test" })
  const iterator = source[Symbol.asyncIterator]()
  const pending = iterator.next()
  await new Promise<void>((resolve) => setImmediate(resolve))
  controller.abort()
  assert.equal((await pending).done, true)
  await iterator.return?.()
})
