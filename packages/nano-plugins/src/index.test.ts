import assert from "node:assert/strict"
import test from "node:test"
import { defineEvent, defineService, defineSlot, PluginBus, type Plugin, type PluginScope } from "./index.js"

test("stages registrations and rolls back a failed apply", async () => {
  const service = defineService<{ value: number }>("test.service")
  const slot = defineSlot<number>("test.slot")
  const bus = new PluginBus()
  await bus.install({
    id: "broken",
    provides: [service],
    apply(scope) {
      scope.provide(service, { value: 1 })
      scope.register(slot, "broken", 1)
      throw new Error("apply failed")
    },
  })
  assert.equal(bus.optional(service), undefined)
  assert.deepEqual(bus.list(slot), [])
  assert.equal(bus.statuses()[0]?.status, "FAILED")
  await bus.close()
})

test("replaces providers while preserving direct service identity for consumers", async () => {
  const service = defineService<{ value: number }>("identity.service")
  const seen: Array<{ value: number }> = []
  const bus = new PluginBus()
  const provider = (value: number): Plugin => ({
    id: "provider",
    provides: [service],
    apply(scope) { scope.provide(service, { value }) },
  })
  await bus.install(provider(1))
  await bus.install({
    id: "consumer",
    requires: [service],
    apply(scope) { seen.push(scope.use(service)) },
  })
  assert.equal(seen[0]?.value, 1)
  await bus.replace(provider(2))
  assert.equal(bus.get(service).value, 2)
  assert.equal(seen.length, 2)
  assert.equal(seen[1]?.value, 2)
  await bus.close()
})

test("recovers a missing required dependency and removes owned listeners and slots", async () => {
  const service = defineService<string>("recovery.service")
  const event = defineEvent<number>("recovery.event")
  const slot = defineSlot<string>("recovery.slot")
  const calls: number[] = []
  const bus = new PluginBus()
  await bus.install({
    id: "consumer",
    requires: [service],
    apply(scope) {
      scope.register(slot, "consumer", "ready")
      scope.on(event, value => { calls.push(value) })
    },
  })
  assert.equal(bus.statuses()[0]?.missingDeps[0], "recovery.service")
  await bus.install({
    id: "provider",
    provides: [service],
    apply(scope) { scope.provide(service, "available") },
  })
  await bus.emit(event, 1)
  assert.deepEqual(calls, [1])
  await bus.disable("provider")
  assert.deepEqual(bus.list(slot), [])
  await bus.emit(event, 2)
  assert.deepEqual(calls, [1])
  await bus.close()
})

test("validates config before activation and bounds a cancelled initialization", async () => {
  let applied = false
  const bus = new PluginBus({ initializeTimeoutMs: 5 })
  await bus.install({
    id: "invalid-config",
    validate() { throw new Error("invalid config") },
    apply() { applied = true },
  })
  assert.equal(applied, false)
  assert.equal(bus.statuses()[0]?.phase, "validate")
  await bus.install({
    id: "never-resolves",
    apply: async scope => {
      await new Promise<void>(() => undefined)
      scope.register(defineSlot<string>("late"), "late", "value")
    },
  })
  assert.equal(bus.statuses().find(status => status.id === "never-resolves")?.status, "FAILED")
  await bus.close()
})

test("installs disabled plugins without running validation and enables them later", async () => {
  const calls: string[] = []
  const bus = new PluginBus()
  await bus.install({
    id: "disabled",
    validate() { calls.push("validate"); throw new Error("must not validate") },
    apply() { calls.push("apply") },
  }, undefined, { enabled: false })
  assert.deepEqual(calls, [])
  assert.equal(bus.statuses()[0]?.status, "DISPOSED")
  await bus.enable("disabled")
  assert.deepEqual(calls, ["validate"])
  assert.equal(bus.statuses()[0]?.status, "FAILED")
  await bus.close()
})

test("owns registrations added through an active scope", async () => {
  const event = defineEvent<void>("active.event")
  const slot = defineSlot<string>("active.slot")
  const calls: string[] = []
  let activeScope: Parameters<Plugin["apply"]>[0] | undefined
  const bus = new PluginBus()
  await bus.install({
    id: "active-owner",
    apply(scope) { activeScope = scope },
  })
  activeScope?.register(slot, "late", "contribution")
  activeScope?.on(event, () => { calls.push("event") })
  activeScope?.own(() => { calls.push("cleanup") })
  assert.deepEqual(activeScope?.list(slot).map(item => item.value), ["contribution"])
  assert.deepEqual(bus.list(slot).map(item => item.value), ["contribution"])
  await bus.emit(event, undefined)
  assert.deepEqual(calls, ["event"])
  await bus.disable("active-owner")
  assert.deepEqual(bus.list(slot), [])
  await bus.emit(event, undefined)
  assert.deepEqual(calls, ["event", "cleanup"])
  await bus.close()
})

test("awaits asynchronous events and isolates listener failures", async () => {
  const event = defineEvent<number>("async.event")
  const calls: number[] = []
  let release: (() => void) | undefined
  const bus = new PluginBus()
  await bus.install({
    id: "async-listener",
    apply(scope) {
      scope.on(event, async value => {
        await new Promise<void>(resolve => { release = resolve })
        calls.push(value)
      })
      scope.on(event, () => { throw new Error("contained listener error") })
    },
  })
  let emitted = false
  const emission = bus.emit(event, 3).then(() => { emitted = true })
  await Promise.resolve()
  assert.equal(emitted, false)
  assert.ok(release)
  release()
  await emission
  assert.equal(emitted, true)
  assert.deepEqual(calls, [3])
  assert.ok(bus.statuses()[0]?.errors.some(error => error.phase === "callback"))
  await bus.close()
})

test("runs asynchronous ownership cleanup in reverse order", async () => {
  const order: string[] = []
  const bus = new PluginBus({ disposeTimeoutMs: 20 })
  await bus.install({
    id: "cleanup",
    apply(scope) {
      scope.own(async () => { await Promise.resolve(); order.push("first") })
      scope.own(() => { order.push("second") })
    },
  })
  await bus.disable("cleanup")
  assert.deepEqual(order, ["second", "first"])
  await bus.close()
})

test("withdraws a live service and unloads its dependents before reconciliation", async () => {
  const service = defineService<number>("withdraw.service")
  const events: string[] = []
  let withdraw: (() => Promise<void>) | undefined
  const bus = new PluginBus()
  await bus.install({
    id: "withdraw-provider",
    provides: [service],
    apply(scope) { withdraw = scope.provide(service, 1) },
  })
  await bus.install({
    id: "withdraw-consumer",
    requires: [service],
    apply(scope) {
      scope.own(() => { events.push("consumer-dispose") })
    },
  })
  assert.ok(withdraw)
  await withdraw!()
  assert.deepEqual(events, ["consumer-dispose"])
  assert.equal(bus.optional(service), undefined)
  assert.equal(bus.statuses().find(status => status.id === "withdraw-consumer")?.status, "PENDING")
  await bus.close()
})

test("reactivates optional consumers without withdrawn services and rebinds on republish", async () => {
  const service = defineService<{ value: number }>("withdraw.optional")
  const providerValues = [{ value: 1 }, { value: 2 }]
  const applyValues: Array<number | undefined> = []
  const cleanupValues: Array<number | undefined> = []
  let withdraw: (() => Promise<void>) | undefined
  let providerScope!: PluginScope
  const bus = new PluginBus()
  await bus.install({
    id: "optional-provider",
    provides: [service],
    apply(scope) {
      providerScope = scope
      withdraw = scope.provide(service, providerValues.shift()!)
    },
  })
  await bus.install({
    id: "optional-consumer",
    optional: [service],
    apply(scope) {
      const captured = scope.optional(service)
      applyValues.push(captured?.value)
      scope.own(() => { cleanupValues.push(captured?.value) })
    },
  })
  assert.deepEqual(applyValues, [1])
  assert.deepEqual(cleanupValues, [])

  assert.ok(withdraw)
  await withdraw!()
  assert.deepEqual(cleanupValues, [1])
  assert.deepEqual(applyValues, [1, undefined])
  assert.equal(bus.statuses().find(status => status.id === "optional-consumer")?.status, "ACTIVE")

  providerScope.provide(service, providerValues.shift()!)
  await bus.install({ id: "republish-boundary", apply() {} })
  assert.deepEqual(applyValues, [1, undefined, 2])
  assert.deepEqual(cleanupValues, [1, undefined])
  await bus.close()
})

test("unloads active generations before replacement graph failures", async () => {
  const serviceA = defineService<number>("replacement.a")
  const serviceB = defineService<number>("replacement.b")
  const disposed: string[] = []
  const bus = new PluginBus()
  await bus.install({
    id: "replacement-a",
    provides: [serviceA],
    apply(scope) { scope.provide(serviceA, 1); scope.own(() => { disposed.push("a") }) },
  })
  await bus.install({
    id: "replacement-b",
    requires: [serviceA],
    provides: [serviceB],
    apply(scope) { scope.provide(serviceB, 2); scope.own(() => { disposed.push("b") }) },
  })
  await bus.replace({
    id: "replacement-a",
    requires: [serviceB],
    provides: [serviceA],
    apply(scope) { scope.provide(serviceA, 3) },
  })
  assert.deepEqual(disposed, ["b", "a"])
  assert.equal(bus.optional(serviceA), undefined)
  assert.equal(bus.optional(serviceB), undefined)
  assert.equal(bus.statuses().find(status => status.id === "replacement-a")?.status, "FAILED")
  assert.equal(bus.statuses().find(status => status.id === "replacement-b")?.status, "FAILED")
  await bus.close()

  const duplicateDisposed: string[] = []
  const duplicateBus = new PluginBus()
  await duplicateBus.install({
    id: "duplicate-a",
    provides: [serviceA],
    apply(scope) { scope.provide(serviceA, 1) },
  })
  await duplicateBus.install({
    id: "duplicate-b",
    apply(scope) { scope.own(() => { duplicateDisposed.push("b") }) },
  })
  await duplicateBus.replace({
    id: "duplicate-b",
    provides: [serviceA],
    apply(scope) { scope.provide(serviceA, 2) },
  })
  assert.deepEqual(duplicateDisposed, ["b"])
  assert.equal(duplicateBus.get(serviceA), 1)
  assert.equal(duplicateBus.statuses().find(status => status.id === "duplicate-b")?.status, "FAILED")
  await duplicateBus.close()
})

test("close aborts a loading apply without waiting for its initialization timeout", async () => {
  let started: (() => void) | undefined
  let release: (() => void) | undefined
  let aborted = false
  let enteredResolve: (() => void) | undefined
  const entered = new Promise<void>(resolve => { enteredResolve = resolve })
  started = enteredResolve
  const bus = new PluginBus({ initializeTimeoutMs: 10_000 })
  const install = bus.install({
    id: "close-loading",
    apply: async scope => {
      started?.()
      scope.signal.addEventListener("abort", () => { aborted = true }, { once: true })
      await new Promise<void>(resolve => { release = resolve })
    },
  })
  await entered
  const close = bus.close()
  await Promise.resolve()
  assert.equal(aborted, true)
  release?.()
  await Promise.all([install, close])
})

test("runs ownership cleanup registered after cancellation", async () => {
  let started: (() => void) | undefined
  let release: (() => void) | undefined
  let cleanupCalls = 0
  let enteredResolve: (() => void) | undefined
  const entered = new Promise<void>(resolve => { enteredResolve = resolve })
  started = enteredResolve
  const bus = new PluginBus()
  const install = bus.install({
    id: "late-own",
    apply: async scope => {
      started?.()
      await new Promise<void>(resolve => { release = resolve })
      scope.own(() => { cleanupCalls++ })
    },
  })
  await entered
  const disable = bus.disable("late-own")
  await Promise.resolve()
  release?.()
  await Promise.all([install, disable])
  assert.equal(cleanupCalls, 1)
  await bus.close()
})

test("closes plugins whose apply returns a service disposer without deadlocking", async () => {
  const service = defineService<number>("close-disposer.service")
  const bus = new PluginBus({ disposeTimeoutMs: 20 })
  await bus.install({
    id: "close-disposer",
    provides: [service],
    apply(scope) { return scope.provide(service, 1) },
  })
  await bus.close()
  assert.deepEqual(bus.inspect(), {
    plugins: 1,
    services: 0,
    slots: 0,
    listeners: 0,
    timers: 0,
    byStatus: { PENDING: 0, LOADING: 0, ACTIVE: 0, FAILED: 0, UNLOADING: 0, DISPOSED: 1 },
  })
  assert.equal(bus.statuses()[0]?.errors.some(error => error.phase === "dispose"), false)
})

test("keeps provider guards live through dependent cleanup on close and disable", async () => {
  const closeWrite = defineService<(value: string) => void>("shutdown.close-write")
  const closeWrites: string[] = []
  const closeOrder: string[] = []
  const closeBus = new PluginBus()
  await closeBus.install({
    id: "close-write-provider",
    provides: [closeWrite],
    apply(scope) { scope.provide(closeWrite, scope.guard(value => { closeWrites.push(value) })) },
  })
  await closeBus.install({
    id: "close-write-consumer",
    requires: [closeWrite],
    apply(scope) {
      const write = scope.use(closeWrite)
      scope.own(() => { write("close"); closeOrder.push("consumer") })
    },
  })
  await closeBus.close()
  assert.deepEqual(closeWrites, ["close"])
  assert.deepEqual(closeOrder, ["consumer"])
  assert.equal(closeBus.inspect().services, 0)
  assert.equal(closeBus.statuses().flatMap(status => status.errors).some(error => error.phase === "dispose"), false)

  const disableWrite = defineService<(value: string) => void>("shutdown.disable-write")
  const disableWrites: string[] = []
  const disableOrder: string[] = []
  const disableBus = new PluginBus()
  await disableBus.install({
    id: "disable-write-provider",
    provides: [disableWrite],
    apply(scope) { scope.provide(disableWrite, scope.guard(value => { disableWrites.push(value) })) },
  })
  await disableBus.install({
    id: "disable-write-consumer",
    requires: [disableWrite],
    apply(scope) {
      const write = scope.use(disableWrite)
      scope.own(() => { write("disable"); disableOrder.push("consumer") })
    },
  })
  await disableBus.disable("disable-write-provider")
  assert.deepEqual(disableWrites, ["disable"])
  assert.deepEqual(disableOrder, ["consumer"])
  assert.equal(disableBus.optional(disableWrite), undefined)
  await disableBus.close()
})

test("watches committed slot snapshots and contains callback failures", async () => {
  const slot = defineSlot<string>("watch.slot")
  const bus = new PluginBus()
  const snapshots: string[][] = []
  const failures: string[][] = []
  await bus.install({
    id: "watcher",
    apply(scope) {
      scope.watch(slot, contributions => {
        snapshots.push(contributions.map(item => item.value))
      })
      scope.watch(slot, async contributions => {
        failures.push(contributions.map(item => item.value))
        if (contributions.some(item => item.value === "first")) throw new Error("observer failed")
      })
    },
  })
  await bus.install({
    id: "contributor",
    apply(scope) { scope.register(slot, "value", "first") },
  })
  await Promise.resolve()
  assert.deepEqual(snapshots, [[], ["first"]])
  assert.deepEqual(failures, [[], ["first"]])
  assert.equal(bus.statuses().find(status => status.id === "watcher")?.errors.some(error => error.phase === "callback"), true)

  await bus.replace({
    id: "contributor",
    apply(scope) { scope.register(slot, "value", "replacement") },
  })
  await Promise.resolve()
  assert.deepEqual(snapshots, [[], ["first"], ["replacement"]])
  await bus.disable("contributor")
  await Promise.resolve()
  assert.deepEqual(snapshots, [[], ["first"], ["replacement"], []])
  await bus.disable("watcher")
  assert.equal(bus.inspect().listeners, 0)
  await bus.close()
})

test("does not publish a failed plugin's staged slot contribution", async () => {
  const slot = defineSlot<string>("watch.failed-slot")
  const bus = new PluginBus()
  const snapshots: string[][] = []
  await bus.install({
    id: "watcher-failed-slot",
    apply(scope) {
      scope.watch(slot, contributions => { snapshots.push(contributions.map(item => item.value)) })
    }
  })
  await bus.install({
    id: "failed-contributor",
    apply(scope) {
      scope.register(slot, "staged", "hidden")
      throw new Error("apply failed")
    },
  })
  await Promise.resolve()
  assert.deepEqual(snapshots, [[]])
  assert.deepEqual(bus.list(slot), [])
  await bus.close()
  assert.equal(bus.inspect().listeners, 0)
})

