import assert from "node:assert/strict"
import test from "node:test"
import type { DiscordMessageTarget } from "../types"
import { initDb } from "../db"
import { findMessageByContentPrefix } from "./db"
import { ingestDiscordEvent, resolveDiscordDeliveryTarget } from "./state"
import { selectDiscordTarget } from "./targets"

const targets: DiscordMessageTarget[] = [
  { position: 1, channelId: "channel-a", messageId: "message-a", itemId: "message-a", content: "first thought" },
  { position: 2, channelId: "channel-a", messageId: "message-b", itemId: "message-b", content: "ok that's good. implement" },
]

test("Discord targets default to latest and resolve ordinals", () => {
  assert.equal(selectDiscordTarget(targets)?.messageId, "message-b")
  assert.equal(selectDiscordTarget(targets, 1)?.messageId, "message-a")
  assert.equal(selectDiscordTarget(targets, 3), null)
})

test("Discord targets resolve normalized case-insensitive content prefixes", () => {
  assert.equal(selectDiscordTarget(targets, "ok that")?.messageId, "message-b")
  assert.equal(selectDiscordTarget(targets, "OK THAT'S GOOD. IMPLEMENT")?.messageId, "message-b")
  assert.equal(selectDiscordTarget(targets, "missing"), null)
})

test("stored Discord messages resolve by a case-insensitive content prefix", async () => {
  initDb(":memory:")
  ingestDiscordEvent({
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

  assert.equal(findMessageByContentPrefix("1509435403143479398", "ok that"), "1549325035091791934")
  assert.equal(findMessageByContentPrefix("1509435403143479398", "OK THAT'S GOOD. IMPLEMENT"), "1549325035091791934")
  assert.equal(findMessageByContentPrefix("1509435403143479398", "not present"), null)

  const selected = await resolveDiscordDeliveryTarget({
    channelId: "1509435403143479398",
    target: "ok that",
  })
  assert.equal(selected.referenceMessageId, "1549325035091791934")
})

test("delivery resolves hidden active targets without model-facing snowflakes", async () => {
  const latest = await resolveDiscordDeliveryTarget({ turnTargets: targets })
  assert.equal(latest.channelId, "channel-a")
  assert.equal(latest.sourceMessageId, null)

  const selected = await resolveDiscordDeliveryTarget({ turnTargets: targets, target: "ok that" })
  assert.equal(selected.channelId, "channel-a")
  assert.equal(selected.sourceItemId, "message-b")
  assert.equal(selected.referenceMessageId, "message-b")

  await assert.rejects(
    resolveDiscordDeliveryTarget({ turnTargets: targets, target: 4 }),
    /target 4 is not present/,
  )
})
