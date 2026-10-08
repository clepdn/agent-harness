import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import test from "node:test"
import { CordisContext, Contributions, getService, onEvent } from "@nano/plugins"
import { config } from "../config"
import { nano } from "../index"
import { discordPlugin } from "@nano/plugin-discord"
import { createPersistencePlugin } from "@nano/plugin-persistence"
import { isDiscordMessageDispatched } from "./db"
import { createDiscordDebounce, type DiscordDebounce } from "./dm-debounce"

function withDebounce(base: number, cap: number, run: (debounce: DiscordDebounce) => void): void {
  const debounce = createDiscordDebounce({ baseMs: base, capMs: cap })
  try {
    run(debounce)
  } finally {
    debounce.reset()
  }
}

test("dm wake fires after base delay when idle", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  withDebounce(5000, 60000, (debounce) => {
    let fired = 0
    const deferred = debounce.debounceDmWake("chanA", "userA", "hello", () => { fired++ })
    assert.equal(deferred, true, "wake should be deferred")
    t.mock.timers.tick(4999)
    assert.equal(fired, 0, "should not fire before base delay")
    t.mock.timers.tick(2)
    assert.equal(fired, 1, "should fire once after base delay")
  })
})

test("typing extends the window", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  withDebounce(5000, 60000, (debounce) => {
    let fired = 0
    debounce.debounceDmWake("chanB", "userB", "hello", () => { fired++ })
    t.mock.timers.tick(4000)
    debounce.noteDmTyping("chanB", "userB")          // reset to now + 5000
    t.mock.timers.tick(4000)
    assert.equal(fired, 0, "typing should have pushed the fire out")
    t.mock.timers.tick(1001)
    assert.equal(fired, 1, "fires 5s after last typing signal")
  })
})

test("follow-up messages are delivered together in arrival order", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  withDebounce(5000, 60000, (debounce) => {
    let delivered: readonly string[] = []
    debounce.debounceDmWake("chanC", "userC", "first", (items) => { delivered = items })
    t.mock.timers.tick(3000)
    debounce.debounceDmWake("chanC", "userC", "second", (items) => { delivered = items })
    t.mock.timers.tick(5001)
    assert.deepEqual(delivered, ["first", "second"])
  })
})

test("configured channel messages share the DM debounce window per channel", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  withDebounce(5000, 60000, (debounce) => {
    let delivered: readonly string[] = []
    debounce.debounceChannelWake("server-channel", "first", (items) => { delivered = items })
    t.mock.timers.tick(3000)
    debounce.debounceChannelWake("server-channel", "second", (items) => { delivered = items })
    t.mock.timers.tick(4999)
    assert.deepEqual(delivered, [])
    t.mock.timers.tick(2)
    assert.deepEqual(delivered, ["first", "second"])
  })
})

test("typing and messages from another author do not extend a burst", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  withDebounce(5000, 60000, (debounce) => {
    let first = 0
    let second = 0
    debounce.debounceDmWake("shared", "alice", "from alice", () => { first++ })
    debounce.debounceDmWake("shared", "bob", "from bob", () => { second++ })
    t.mock.timers.tick(4000)
    debounce.noteDmTyping("shared", "bob")
    t.mock.timers.tick(1001)
    assert.equal(first, 1)
    assert.equal(second, 0)
    t.mock.timers.tick(4000)
    assert.equal(second, 1)
  })
})

test("typing without an author never invents or changes a pending wake", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  withDebounce(5000, 60000, (debounce) => {
    let fired = 0
    debounce.debounceDmWake("chan-no-user", "alice", "hello", () => { fired++ })
    t.mock.timers.tick(4000)
    debounce.noteDmTyping("chan-no-user")
    t.mock.timers.tick(1001)
    assert.equal(fired, 1)
  })
})

test("cap bounds total hold even with continuous typing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  withDebounce(5000, 60000, (debounce) => {
    let fired = 0
    debounce.debounceDmWake("chanD", "userD", "hello", () => { fired++ })
    // Type every 3s for a long time; without a cap this never fires.
    for (let elapsed = 0; elapsed < 90000; elapsed += 3000) {
      t.mock.timers.tick(3000)
      debounce.noteDmTyping("chanD", "userD")
    }
    assert.equal(fired, 1, "cap should have forced a single fire by 60s")
  })
})

test("disabled when base delay is zero", () => {
  withDebounce(0, 60000, (debounce) => {
    let fired = 0
    const deferred = debounce.debounceDmWake("chanE", "userE", "hello", () => { fired++ })
    assert.equal(deferred, false, "should not defer when disabled")
    assert.equal(fired, 0, "caller handles the wake, debouncer stays out")
  })
})

test("Discord plugin batches a DM burst into one priority wake and dispatches every live message", { timeout: 15_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const home = await mkdtemp("/tmp/nano-discord-debounce-")
  const ctx = new CordisContext()
  await ctx.plugin(Contributions)
  const originalFetch = globalThis.fetch
  const originalGatewayEnabled = config.discord.gateway_enabled
  const originalDebounceMs = config.discord.dm_wake_debounce_ms
  const originalDebounceCapMs = config.discord.dm_wake_debounce_cap_ms
  const wakes: Array<{ event: { content: string; discordTargets?: Array<{ position: number; messageId?: string }> }; priority?: boolean }> = []
  const wakeListener = {
    name: "discord-debounce-wake-listener",
    apply(ctx: CordisContext) {
      onEvent(ctx, nano.wake, (wake) => { wakes.push(wake) })
    },
  }

  config.discord.gateway_enabled = false
  config.discord.dm_wake_debounce_ms = 5_000
  config.discord.dm_wake_debounce_cap_ms = 60_000
  globalThis.fetch = async () => new Response(null, { status: 404 })
  try {
    await ctx.plugin(createPersistencePlugin({ home, path: ":memory:" }), {})
    await ctx.plugin(wakeListener)
    await ctx.plugin(discordPlugin)
    const service = getService(ctx, nano.discord)
    const makeMessage = (id: string, content: string, second: number) => ({
      message: { id, channel_id: "dm-debounce-channel", guild_id: null, content, timestamp: `2026-06-15T12:00:0${second}.000Z`, author: { id: "dm-debounce-user", username: "test-user" } },
      channel: { id: "dm-debounce-channel", type: 1 }, is_dm: true,
    })

    const first = service.ingress(makeMessage("dm-101", "first burst text", 0))
    const abortController = new AbortController()
    const aborted = service.ingress(makeMessage("dm-102", "cancelled burst text", 1), abortController.signal)
    abortController.abort()
    const last = service.ingress(makeMessage("dm-103", "last burst text", 2))
    const settled = Promise.allSettled([first, aborted, last])

    assert.equal(wakes.length, 0, "the DM burst should wait for the debounce window")
    t.mock.timers.tick(5_000)

    const outcomes = await settled
    assert.equal(outcomes[0]?.status, "fulfilled")
    assert.deepEqual(outcomes[0]?.status === "fulfilled" ? outcomes[0].value : undefined, { ok: true, running: true })
    assert.equal(outcomes[1]?.status, "rejected", "the aborted queued ingress must settle as cancelled")
    assert.match(String(outcomes[1]?.status === "rejected" ? outcomes[1].reason : ""), /cancelled/)
    assert.equal(outcomes[2]?.status, "fulfilled")
    assert.deepEqual(outcomes[2]?.status === "fulfilled" ? outcomes[2].value : undefined, { ok: true, running: true })
    assert.equal(wakes.length, 1, "a burst must publish one nano.wake, not one wake per fragment")
    const wake = wakes[0]!
    assert.equal(wake.priority, true)
    const firstTextPosition = wake.event.content.indexOf("first burst text")
    const lastTextPosition = wake.event.content.indexOf("last burst text")
    assert.ok(firstTextPosition >= 0, "the wake should include the first message")
    assert.ok(lastTextPosition >= 0, "the wake should include the last message")
    assert.ok(firstTextPosition < lastTextPosition, "the wake should preserve chronological message order")
    assert.deepEqual(wake.event.discordTargets?.map(({ position, messageId }) => ({ position, messageId })), [
      { position: 1, messageId: "dm-101" }, { position: 2, messageId: "dm-103" },
    ])
    const db = getService(ctx, nano.persistence).getDb()
    assert.equal(isDiscordMessageDispatched(db, "dm-101"), true)
    assert.equal(isDiscordMessageDispatched(db, "dm-103"), true)
    assert.equal(isDiscordMessageDispatched(db, "dm-102"), false, "aborted messages must not be marked dispatched")
  } finally {
    await ctx.fiber.dispose()
    config.discord.gateway_enabled = originalGatewayEnabled
    config.discord.dm_wake_debounce_ms = originalDebounceMs
    config.discord.dm_wake_debounce_cap_ms = originalDebounceCapMs
    globalThis.fetch = originalFetch
    await rm(home, { recursive: true, force: true })
  }
})
