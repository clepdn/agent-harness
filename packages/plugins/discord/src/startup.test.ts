import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import test from "node:test"
import type { Client } from "discord.js"
import { Contributions, CordisContext, getService } from "@nano/plugins"
import { nano } from "@nano/runtime-api"
import { createPersistencePlugin } from "@nano/plugin-persistence"
import { createDiscordPlugin } from "./index"
import { setDiscordPresence, startDiscordGateway, type DiscordGatewayOptions } from "./discord/gateway"

test("gateway startup failure leaves the Discord service available offline", async (t) => {
  const home = await mkdtemp("/tmp/nano-discord-startup-")
  const ctx = new CordisContext()
  t.after(async () => {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  const warnings: unknown[][] = []
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args) })
  await ctx.plugin(Contributions)
  await ctx.plugin(createPersistencePlugin({ home, path: ":memory:" }), {})

  await ctx.plugin(createDiscordPlugin({
    startGateway: async () => { throw new Error("shard out of range") },
  }))

  assert.equal(getService(ctx, nano.discord).available, false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!.map(String).join(" "), /startup failed.*shard out of range/i)
})

test("presence shard races are logged without rejecting ready initialization", async (t) => {
  const warnings: unknown[][] = []
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args) })
  const client = {
    user: {
      setPresence() { throw new RangeError("Shard 0 not found") },
    },
  } as unknown as Client

  await setDiscordPresence(client, "resting")

  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!.map(String).join(" "), /failed to update presence.*Shard 0 not found/)
})

test("invalid gateway tokens do not leave an orphaned readiness rejection", async () => {
  const options = {
    db: {},
    commands: [],
    enabled: true,
    token: "invalid.invalid.invalid",
    trace: false,
    rawFallback: false,
    rawFallbackAll: false,
    wakeOnReaction: false,
    dmWhitelist: [],
    botUserId: "",
    ownerId: "",
    typingEnabled: false,
    onIngress: () => ({ ingested: false, woke: false, reason: "test" }),
    routeEvent() {},
    debounce: { noteDmTyping() {}, reset() {} },
    typing: { configure() {}, reset() {} },
    statusUpdater: { start() {}, stop() {} },
    voice: {
      setClient() {},
      setDelegationCallback() {},
      stop: async () => {},
    },
    alerts: { setSender() {} },
  } as unknown as DiscordGatewayOptions

  await assert.rejects(startDiscordGateway(options), /invalid token/i)
})
