import assert from "node:assert/strict"
import test from "node:test"
import {
  CordisContext,
  Contributions,
  configSchema,
  defineEvent,
  defineService,
  defineSlot,
  emitEvent,
  findService,
  getService,
  listContributions,
  onEvent,
  registerContribution,
  watchContributions,
} from "./index.js"

test("contributions follow native fiber activity and dispose with their owner", async () => {
  const ctx = new CordisContext()
  const slot = defineSlot<string>("test.native-slot")
  const snapshots: string[][] = []

  assert.deepEqual(listContributions(ctx, slot), [])
  const contributionService = await ctx.plugin(Contributions)
  const watcher = await ctx.plugin({
    name: "test.watcher",
    inject: ["nano.contributions"],
    apply(ctx) {
      watchContributions(ctx, slot, (items) => { snapshots.push(items.map((item) => item.value)) })
    },
  })
  const contributor = await ctx.plugin({
    name: "test.contributor",
    inject: ["nano.contributions"],
    apply(ctx) {
      registerContribution(ctx, slot, "value", "first")
    },
  })

  assert.deepEqual(listContributions(ctx, slot).map((item) => item.value), ["first"])
  assert.deepEqual(snapshots, [[], ["first"]])
  assert.equal(listContributions(ctx, slot)[0]?.owner, "test.contributor")

  await contributor.dispose()
  assert.deepEqual(listContributions(ctx, slot), [])
  assert.deepEqual(snapshots, [[], ["first"], []])
  await watcher.dispose()
  await contributionService.dispose()
})

test("duplicate contribution keys are rejected without replacing the active entry", async () => {
  const ctx = new CordisContext()
  const slot = defineSlot<number>("test.duplicate-slot")
  const contributionService = await ctx.plugin(Contributions)
  const first = await ctx.plugin({
    name: "test.first-contributor",
    inject: ["nano.contributions"],
    apply(ctx) {
      registerContribution(ctx, slot, "same", 1)
    },
  })

  await assert.rejects(async () => {
    await ctx.plugin({
      name: "test.second-contributor",
      inject: ["nano.contributions"],
      apply(ctx) {
        registerContribution(ctx, slot, "same", 2)
      },
    })
  }, /already registered/)
  assert.deepEqual(listContributions(ctx, slot).map((item) => item.value), [1])

  await first.dispose()
  await contributionService.dispose()
})

test("native service, event, and Standard Schema helpers preserve their typed contracts", async () => {
  const ctx = new CordisContext()
  const service = defineService<{ value: number }>("test.native-service")
  const event = defineEvent<number>("test.native-event")
  const observed: number[] = []
  const provider = await ctx.plugin({
    name: "test.service-provider",
    apply(ctx) {
      ctx.provide(service.name, { value: 42 })
    },
  })
  const listener = await ctx.plugin({
    name: "test.event-listener",
    apply(ctx) {
      onEvent(ctx, event, (value) => observed.push(value))
    },
  })

  assert.equal(getService(ctx, service).value, 42)
  assert.equal(findService(ctx, service)?.value, 42)
  await emitEvent(ctx, event, 7)
  assert.deepEqual(observed, [7])

  const plugin = Object.assign(
    (_ctx: CordisContext, config: { value: number }) => {
      observed.push(config.value)
    },
    {
      Config: configSchema((value: unknown) => {
        if (!value || typeof value !== "object" || !("value" in value)) throw new TypeError("value is required")
        const parsed = Number(value.value)
        if (!Number.isFinite(parsed)) throw new TypeError("value must be numeric")
        return { value: parsed }
      }),
    },
  )
  const configured = await ctx.plugin(plugin, { value: "9" } as unknown as { value: number })
  assert.equal(observed.at(-1), 9)
  await assert.rejects(async () => {
    await ctx.plugin(plugin, {} as { value: number })
  }, /value is required/)

  await configured.dispose()
  await listener.dispose()
  await provider.dispose()
})
