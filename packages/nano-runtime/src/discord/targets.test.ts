import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import type { DiscordMessageTarget } from "../types"
import { createDatabase } from "../db"
import { findMessageByContentPrefix } from "./db"
import { ingestDiscordEvent, resolveDiscordDeliveryTarget } from "./state"
import { DISCORD_TARGET_CAPACITY, registerDiscordTargets, rewriteDiscordTargetLabels, selectDiscordTarget } from "./targets"

function database(t: TestContext) {
  const db = createDatabase(":memory:").db
  t.after(() => db.close())
  return db
}

const targets: DiscordMessageTarget[] = [
  { position: 1, friendlyId: "alder-bell-book", channelId: "channel-a", messageId: "message-a", itemId: "message-a", content: "first thought" },
  { position: 2, friendlyId: "bamboo-bell-basket", channelId: "channel-a", messageId: "message-b", itemId: "message-b", content: "ok that's good. implement" },
]

test("Discord targets default to latest and resolve ordinals", () => {
  assert.equal(selectDiscordTarget(targets)?.messageId, "message-b")
  assert.equal(selectDiscordTarget(targets, 1)?.messageId, "message-a")
  assert.equal(selectDiscordTarget(targets, 3), null)
})

test("Discord targets resolve normalized case-insensitive content prefixes", () => {
  assert.equal(selectDiscordTarget(targets, "ok that")?.messageId, "message-b")
  assert.equal(selectDiscordTarget(targets, "OK THAT'S GOOD. IMPLEMENT")?.messageId, "message-b")
  assert.equal(selectDiscordTarget(targets, "bamboo-bell-basket")?.messageId, "message-b")
  assert.equal(selectDiscordTarget(targets, "missing"), null)
})

test("Discord target slots advance across separate single-message events", () => {
  const firstIncoming: DiscordMessageTarget[] = [{ position: 1, channelId: "dm-a", messageId: "message-1", content: "first" }]
  const first = registerDiscordTargets([], firstIncoming)
  assert.equal(first.incomingTargets[0]?.position, 1)
  assert.equal(rewriteDiscordTargetLabels("target: 1", firstIncoming, first.incomingTargets), "target: 1")

  const secondIncoming: DiscordMessageTarget[] = [{ position: 1, channelId: "dm-a", messageId: "message-2", content: "second" }]
  const second = registerDiscordTargets(first.targets, secondIncoming)
  assert.equal(second.incomingTargets[0]?.position, 2)
  assert.equal(rewriteDiscordTargetLabels("target: 1", secondIncoming, second.incomingTargets), "target: 2")
  assert.deepEqual(second.targets.map((target) => target.messageId), ["message-1", "message-2"])
})

test("Discord target registry wraps after sixteen slots and replaces the old occupant", () => {
  let registry: DiscordMessageTarget[] = []
  for (let index = 1; index <= DISCORD_TARGET_CAPACITY + 1; index += 1) {
    const registered = registerDiscordTargets(registry, [{ position: 1, channelId: "dm-a", messageId: `message-${index}`, content: `message ${index}` }])
    registry = registered.targets
  }
  assert.equal(registry.length, DISCORD_TARGET_CAPACITY)
  assert.equal(registry.some((target) => target.messageId === "message-1"), false)
  assert.equal(selectDiscordTarget(registry, 1)?.messageId, "message-17")
  assert.equal(selectDiscordTarget(registry, 2)?.messageId, "message-2")
})

test("Discord target registry preserves the slot for a re-surfaced message", () => {
  const first = registerDiscordTargets([], [
    { position: 1, channelId: "dm-a", messageId: "message-1", content: "first" },
    { position: 2, channelId: "dm-a", messageId: "message-2", content: "second" },
  ])
  const repeated = registerDiscordTargets(first.targets, [{ position: 1, channelId: "dm-a", messageId: "message-1", content: "first, updated" }])
  const next = registerDiscordTargets(repeated.targets, [{ position: 1, channelId: "dm-a", messageId: "message-3", content: "third" }])
  assert.equal(repeated.incomingTargets[0]?.position, 1)
  assert.equal(next.incomingTargets[0]?.position, 3)
})

test("stored Discord messages resolve by a case-insensitive content prefix", async (t) => {
  const db = database(t)
  ingestDiscordEvent(db, {
    message: {
      id: "1549325035091791934",
      channel_id: "1509435403143479398",
      guild_id: "1509435403143479000",
      content: "ok that's good. implement",
      author: { id: "1", username: "callie" },
    },
    channel: { id: "1509435403143479398", type: 0, name: "general" },
    guild_name: "home",
  })
  assert.equal(findMessageByContentPrefix(db, "1509435403143479398", "ok that"), "1549325035091791934")
  assert.equal(findMessageByContentPrefix(db, "1509435403143479398", "OK THAT'S GOOD. IMPLEMENT"), "1549325035091791934")
  assert.equal(findMessageByContentPrefix(db, "1509435403143479398", "not present"), null)
  const selected = await resolveDiscordDeliveryTarget(db, { channelId: "1509435403143479398", target: "ok that" })
  assert.equal(selected.referenceMessageId, null)
  const explicit = await resolveDiscordDeliveryTarget(db, { channelId: "1509435403143479398", target: "ok that", replyMode: "explicit" })
  assert.equal(explicit.referenceMessageId, null)
})

test("delivery resolves hidden active targets without model-facing snowflakes", async (t) => {
  const db = database(t)
  const latest = await resolveDiscordDeliveryTarget(db, { turnTargets: targets })
  assert.equal(latest.channelId, "channel-a")
  assert.equal(latest.sourceMessageId, null)
  const selected = await resolveDiscordDeliveryTarget(db, { turnTargets: targets, target: "ok that" })
  assert.equal(selected.channelId, "channel-a")
  assert.equal(selected.sourceItemId, "message-b")
  assert.equal(selected.referenceMessageId, null)
  const explicit = await resolveDiscordDeliveryTarget(db, { turnTargets: targets, target: "ok that", replyMode: "explicit" })
  assert.equal(explicit.referenceMessageId, null)
  await assert.rejects(resolveDiscordDeliveryTarget(db, { turnTargets: targets, target: 4 }), /target 4 is not present/)
})

test("auto replies stay plain for the next message and after the first reply in a response group", async (t) => {
  const db = database(t)
  const channelId = "1509435403143479398"
  const sourceMessageId = "1549325035091792001"
  const sourceTarget: DiscordMessageTarget = { position: 1, channelId, messageId: sourceMessageId, itemId: sourceMessageId, content: "can you do that?" }
  const ingest = (message: Record<string, unknown>, authorIsBot = false) => ingestDiscordEvent(db, {
    message: { channel_id: channelId, guild_id: "1509435403143479000", timestamp: new Date().toISOString(), ...message },
    channel: { id: channelId, type: 0, name: "general" }, guild_name: "home", author_is_bot: authorIsBot,
  })
  ingest({ id: sourceMessageId, content: "can you do that?", timestamp: new Date(Date.now() - 20 * 60_000).toISOString(), author: { id: "100", username: "belle" } })
  const immediate = await resolveDiscordDeliveryTarget(db, { turnTargets: [sourceTarget], target: 1 })
  assert.equal(immediate.referenceMessageId, null)
  ingest({ id: "1549325035091792002", content: "aired", author: { id: "200", username: "callie" } })
  const firstGroupedResponse = await resolveDiscordDeliveryTarget(db, { turnTargets: [sourceTarget], target: 1 })
  assert.equal(firstGroupedResponse.referenceMessageId, sourceMessageId)
  ingest({ id: "1549325035091792003", content: "hi belle - yes absolutely!", message_reference: { message_id: sourceMessageId, channel_id: channelId }, author: { id: "300", username: "nano", bot: true } }, true)
  const secondGroupedResponse = await resolveDiscordDeliveryTarget(db, { turnTargets: [sourceTarget], target: 1 })
  assert.equal(secondGroupedResponse.referenceMessageId, null)
  ingest({ id: "1549325035091792004", content: "yes! sorry!", author: { id: "300", username: "nano", bot: true } }, true)
  const thirdGroupedResponse = await resolveDiscordDeliveryTarget(db, { turnTargets: [sourceTarget], target: 1 })
  assert.equal(thirdGroupedResponse.referenceMessageId, null)
  ingest({ id: "1549325035091792005", content: "any update?", author: { id: "200", username: "callie" } })
  const afterNewMessage = await resolveDiscordDeliveryTarget(db, { turnTargets: [sourceTarget], target: 1 })
  assert.equal(afterNewMessage.referenceMessageId, sourceMessageId)
})

test("explicit replies use the same reference eligibility policy as auto replies", async (t) => {
  const db = database(t)
  const channelId = "1509435403143479398"
  const sourceMessageId = "1549325035091793001"
  const sourceTarget: DiscordMessageTarget = { position: 1, channelId, messageId: sourceMessageId, itemId: sourceMessageId, content: "tell me more" }
  const ingest = (message: Record<string, unknown>, authorIsBot = false) => ingestDiscordEvent(db, {
    message: { channel_id: channelId, guild_id: "1509435403143479000", timestamp: new Date().toISOString(), ...message },
    channel: { id: channelId, type: 0, name: "general" }, guild_name: "home", author_is_bot: authorIsBot,
  })
  ingest({ id: sourceMessageId, content: "tell me more", author: { id: "100", username: "belle" } })
  const first = await resolveDiscordDeliveryTarget(db, { turnTargets: [sourceTarget], target: 1, replyMode: "explicit" })
  assert.equal(first.referenceMessageId, null)
  ingest({ id: "1549325035091793002", content: "aired", author: { id: "200", username: "callie" } })
  const eligible = await resolveDiscordDeliveryTarget(db, { turnTargets: [sourceTarget], target: 1, replyMode: "explicit" })
  assert.equal(eligible.referenceMessageId, sourceMessageId)
  ingest({ id: "1549325035091793003", content: "part one", message_reference: { message_id: sourceMessageId, channel_id: channelId }, author: { id: "300", username: "nano", bot: true } }, true)
  const second = await resolveDiscordDeliveryTarget(db, { turnTargets: [sourceTarget], target: 1, replyMode: "explicit" })
  assert.equal(second.referenceMessageId, null)
  ingest({ id: "1549325035091793004", content: "part two", author: { id: "300", username: "nano", bot: true } }, true)
  const third = await resolveDiscordDeliveryTarget(db, { turnTargets: [sourceTarget], target: 1, replyMode: "explicit" })
  assert.equal(third.referenceMessageId, null)
  ingest({ id: "1549325035091793005", content: "go on", author: { id: "200", username: "callie" } })
  const afterNewMessage = await resolveDiscordDeliveryTarget(db, { turnTargets: [sourceTarget], target: 1, replyMode: "explicit" })
  assert.equal(afterNewMessage.referenceMessageId, sourceMessageId)
})
