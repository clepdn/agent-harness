import assert from "node:assert/strict"
import test from "node:test"
import { CordisContext, Contributions, listContributions, type Plugin } from "@nano/plugins"
import { workerAwpEnqueue, workerEvents, workerStatus } from "@nano/protocol"
import { nano, type LifecycleService, type RunnerService } from "@nano/runtime-api"
import { workerOperationsPlugin } from "@nano/plugin-worker-operations"
import { createPersistencePlugin } from "@nano/plugin-persistence"
import { mkdtemp, rm } from "node:fs/promises"

function fakeRunner(): RunnerService {
  return {
    activate() {}, wake: async () => {}, enqueue: () => true,
    status: () => ({ agentId: "fake-worker", running: false, idle: true, tokenCount: 0, contextSize: 1000, processStartedAt: "2026-01-01T00:00:00.000Z", uptimeMs: 1 }),
    interrupt: () => "idle", discard: () => true, rest: () => true, compact: () => true,
    swapModel: async (preset) => ({ preset, model: "fake", provider: "fake", graceful: true }),
    modelSnapshot: () => ({ primary: null, fallback: { id: "fake", provider: "fake", baseUrl: "https://fake.invalid" }, respectPromptCache: true, useFallback: false, enableThinking: false, thinkingEffort: "none", vision: false }),
    trigger: async (source) => ({ ok: true, source }),
  }
}

const fakeLifecycle: LifecycleService = { shutdown() {}, restart() {} }

function providerPlugin(runner: RunnerService, lifecycle: LifecycleService): Plugin {
  return {
    name: "fake-worker-services",
    inject: ["nano.contributions"],
    apply(ctx) {
      ctx.provide(nano.runner.name, runner)
      ctx.provide(nano.lifecycle.name, lifecycle)
    },
  }
}

function operation(ctx: CordisContext, name: string) {
  const contribution = listContributions(ctx, nano.operations).find((entry) => entry.key === name)
  assert.ok(contribution, `missing operation ${name}`)
  return contribution.value
}

async function rootContext() {
  const ctx = new CordisContext()
  await ctx.plugin(Contributions)
  return ctx
}

test("worker operations are public service bindings and unload with their owner", async () => {
  const ctx = await rootContext()
  await ctx.plugin(providerPlugin(fakeRunner(), fakeLifecycle))
  const fiber = await ctx.plugin(workerOperationsPlugin)
  const context = { signal: new AbortController().signal, subject: "test" }
  const status = workerStatus.output.parse(await operation(ctx, workerStatus.name).handler({}, context))
  assert.equal(status.agentId, "fake-worker")
  assert.equal(status.idle, true)
  const enqueue = await operation(ctx, workerAwpEnqueue.name).handler({ event: { source: "chat", triggeredAt: "2026-01-01T00:00:00.000Z", content: "hello", raw: null } }, context)
  assert.deepEqual(enqueue, { ok: true, running: false })
  await fiber.dispose()
  assert.equal(listContributions(ctx, nano.operations).some((entry) => entry.key === workerStatus.name), false)
  await ctx.fiber.dispose()
})

test("worker operation callbacks fail closed when an optional service is absent", async () => {
  const ctx = await rootContext()
  await ctx.plugin(providerPlugin(fakeRunner(), fakeLifecycle))
  await ctx.plugin(workerOperationsPlugin)
  const events = operation(ctx, "worker.events.list")
  await assert.rejects(async () => { await events.handler({}, { signal: new AbortController().signal, subject: "test" }) }, /nano\.persistence service is unavailable/)
  await ctx.fiber.dispose()
})

test("cancelling an idle worker stream settles next without another published event", async (t) => {
  const home = await mkdtemp("/tmp/nano-worker-stream-")
  const ctx = await rootContext()
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  await ctx.plugin(createPersistencePlugin({ home, path: ":memory:" }), {})
  await ctx.plugin(providerPlugin(fakeRunner(), fakeLifecycle))
  await ctx.plugin(workerOperationsPlugin)
  const stream = listContributions(ctx, nano.streams).find((entry) => entry.key === workerEvents.name)
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
