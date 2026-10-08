import assert from "node:assert/strict"
import test from "node:test"
import { cacheWarmingCompactionAt, createCacheWarmer } from "./cache-warmer"
import type { Context, Usage } from "../llm"

const usage: Usage = { input: 0, output: 0, cacheRead: 2048, cacheWrite: 0, totalTokens: 2048,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

test("warming runs before expiry, real requests postpone it, and refreshes repeat without waking the agent", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  let calls = 0
  let billed = 0
  const context = { lastCacheUseAt: Date.now(), warmCache: async (options: { mode?: string } = {}) => {
    assert.equal(options.mode, "prewarm")
    calls++
    context.lastCacheUseAt = Date.now()
    return usage
  } }
  const warmer = createCacheWarmer({ target: () => ({ context, lifetimeMs: 30 * 60_000, mode: "prewarm", enabled: true, busy: false }),
    onUsage: () => { billed++ }, onError: (error) => { throw error } })
  t.after(() => warmer.stop())
  // Tick once per minute so nested timers observe each successive minute.
  for (let i = 0; i < 20; i++) t.mock.timers.tick(60_000)
  context.lastCacheUseAt = Date.now() // A normal request refreshed the prefix.
  for (let i = 0; i < 26; i++) t.mock.timers.tick(60_000)
  assert.equal(calls, 0)
  t.mock.timers.tick(60_000)
  await settle()
  assert.equal(calls, 1)
  for (let i = 0; i < 27; i++) t.mock.timers.tick(60_000)
  await settle()
  assert.equal(calls, 2)
  assert.equal(billed, 2)
})

test("disabled, busy, and unseeded contexts skip warming; stop aborts in-flight refreshes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  let enabled = false
  let busy = false
  let calls = 0
  let signal: AbortSignal | undefined
  let release!: () => void
  const context = { lastCacheUseAt: undefined as number | undefined, warmCache: async (options: { signal?: AbortSignal } = {}) => {
    calls++
    signal = options.signal
    await new Promise<void>((resolve) => { release = resolve })
    return usage
  } }
  const warmer = createCacheWarmer({ target: () => ({ context, lifetimeMs: 4 * 60_000, mode: "completion", enabled, busy }),
    onUsage: () => {}, onError: (error) => { throw error } })
  t.mock.timers.tick(60_000)
  enabled = true
  t.mock.timers.tick(60_000)
  context.lastCacheUseAt = 0
  busy = true
  t.mock.timers.tick(60_000)
  assert.equal(calls, 0)
  busy = false
  t.mock.timers.tick(60_000)
  assert.equal(calls, 1)
  t.mock.timers.tick(120_000)
  assert.equal(calls, 1, "refreshes must not overlap")
  warmer.stop()
  assert.equal(signal?.aborted, true)
  release()
  await settle()
  t.mock.timers.tick(1_000_000)
  assert.equal(calls, 1)
})

test("failures retry later and use a replaced Context rather than a stale lineage", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  let calls = 0
  let errors = 0
  let context: Pick<Context, "lastCacheUseAt" | "warmCache"> = { lastCacheUseAt: 0,
    warmCache: async () => { calls++; throw new Error("unavailable") } }
  const warmer = createCacheWarmer({ target: () => ({ context, lifetimeMs: 4 * 60_000, mode: "prewarm", enabled: true, busy: false }),
    onUsage: () => {}, onError: () => { errors++ } })
  t.after(() => warmer.stop())
  t.mock.timers.tick(60_000)
  await settle()
  assert.equal(errors, 1)
  t.mock.timers.tick(59_999)
  assert.equal(calls, 1)
  context = { lastCacheUseAt: 0, warmCache: async () => { calls++; return usage } }
  t.mock.timers.tick(1)
  await settle()
  assert.equal(calls, 2)
})

test("quiet budgets round up to refresh boundaries, including exact boundaries and disabled budgets", () => {
  const minute = 60_000
  assert.equal(cacheWarmingCompactionAt(0, 30 * minute, 315 * minute), 324 * minute)
  assert.equal(cacheWarmingCompactionAt(0, 30 * minute, 324 * minute), 324 * minute)
  assert.equal(cacheWarmingCompactionAt(10 * minute, 30 * minute, minute), 37 * minute)
  for (const duration of [0, -1, NaN, Infinity]) assert.equal(cacheWarmingCompactionAt(0, minute, duration), undefined)
  assert.equal(cacheWarmingCompactionAt(undefined, minute, minute), undefined)
  assert.equal(cacheWarmingCompactionAt(0, 0, minute), undefined)
})

test("non-30-minute lifetimes refresh three minutes early, and shorter lifetimes disable refreshes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  let calls = 0
  const context = { lastCacheUseAt: 0, warmCache: async () => { calls++; context.lastCacheUseAt = Date.now(); return usage } }
  let lifetimeMs = 20 * 60_000
  const warmer = createCacheWarmer({ target: () => ({ context, lifetimeMs, mode: "prewarm", enabled: true, busy: false }),
    onUsage: () => {}, onError: (error) => { throw error } })
  t.after(() => warmer.stop())
  for (let i = 0; i < 16; i++) t.mock.timers.tick(60_000)
  assert.equal(calls, 0)
  t.mock.timers.tick(60_000)
  await settle()
  assert.equal(calls, 1)
  lifetimeMs = 3 * 60_000
  for (let i = 0; i < 30; i++) t.mock.timers.tick(60_000)
  await settle()
  assert.equal(calls, 1)
})

test("warming does not extend a finite quiet budget and stops before the compaction boundary", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const minute = 60_000
  let calls = 0
  const context = { lastCompletionAt: 0, lastCacheUseAt: 0, warmCache: async () => {
    calls++
    context.lastCacheUseAt = Date.now()
    return usage
  } }
  const warmer = createCacheWarmer({ target: () => ({ context, lifetimeMs: 30 * minute, durationMs: 315 * minute,
    mode: "prewarm", enabled: true, busy: false }), onUsage: () => {}, onError: (error) => { throw error } })
  t.after(() => warmer.stop())
  for (let i = 0; i < 324; i++) {
    t.mock.timers.tick(minute)
    await settle()
  }
  assert.equal(calls, 11, "warm at 27 through 297 minutes; compact instead of warming at 324")
  assert.equal(context.lastCompletionAt, 0)
  for (let i = 0; i < 27; i++) t.mock.timers.tick(minute)
  await settle()
  assert.equal(calls, 11, "an expired budget must not keep warming")
  context.lastCompletionAt = Date.now() // A real request starts a fresh quiet budget.
  context.lastCacheUseAt = Date.now()
  for (let i = 0; i < 27; i++) t.mock.timers.tick(minute)
  await settle()
  assert.equal(calls, 12)
})
