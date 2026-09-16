import assert from "node:assert/strict"
import test from "node:test"
import type { DiscordMessageTarget } from "../types"
import { initDb } from "../db"
import { findMessageByContentPrefix } from "./db"
import { ingestDiscordEvent, resolveDiscordDeliveryTarget } from "./state"
import { selectDiscordTarget } from "./targets"

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
  assert.equal(selected.referenceMessageId, null)

  const explicit = await resolveDiscordDeliveryTarget({
    channelId: "1509435403143479398",
    target: "ok that",
    replyMode: "explicit",
  })
  assert.equal(explicit.referenceMessageId, "1549325035091791934")
})

test("delivery resolves hidden active targets without model-facing snowflakes", async () => {
  const latest = await resolveDiscordDeliveryTarget({ turnTargets: targets })
  assert.equal(latest.channelId, "channel-a")
  assert.equal(latest.sourceMessageId, null)

  const selected = await resolveDiscordDeliveryTarget({ turnTargets: targets, target: "ok that" })
  assert.equal(selected.channelId, "channel-a")
  assert.equal(selected.sourceItemId, "message-b")
  assert.equal(selected.referenceMessageId, null)

  const explicit = await resolveDiscordDeliveryTarget({
    turnTargets: targets,
    target: "ok that",
    replyMode: "explicit",
  })
  assert.equal(explicit.referenceMessageId, "message-b")

  await assert.rejects(
    resolveDiscordDeliveryTarget({ turnTargets: targets, target: 4 }),
    /target 4 is not present/,
  )
})

test("auto replies stay plain for the next message and after the first reply in a response group", async () => {
  initDb(":memory:")
  const channelId = "1509435403143479398"
  const sourceMessageId = "1549325035091792001"
  const sourceTarget: DiscordMessageTarget = {
    position: 1,
    channelId,
    messageId: sourceMessageId,
    itemId: sourceMessageId,
    content: "can you do that?",
  }

  const ingest = (message: Record<string, unknown>, authorIsBot = false) =>
    ingestDiscordEvent({
      message: {
        channel_id: channelId,
        guild_id: "1509435403143479000",
        timestamp: new Date().toISOString(),
        ...message,
      },
      channel: { id: channelId, type: 0, name: "general" },
      guild_name: "home",
      author_is_bot: authorIsBot,
    })

  ingest({
    id: sourceMessageId,
    content: "can you do that?",
    timestamp: new Date(Date.now() - 20 * 60_000).toISOString(),
    author: { id: "100", username: "belle" },
  })

  const immediate = await resolveDiscordDeliveryTarget({
    turnTargets: [sourceTarget],
    target: 1,
  })
  assert.equal(immediate.referenceMessageId, null)

  ingest({
    id: "1549325035091792002",
    content: "aired",
    author: { id: "200", username: "callie" },
  })

  const firstGroupedResponse = await resolveDiscordDeliveryTarget({
    turnTargets: [sourceTarget],
    target: 1,
  })
  assert.equal(firstGroupedResponse.referenceMessageId, sourceMessageId)

  ingest({
    id: "1549325035091792003",
    content: "hi belle - yes absolutely!",
    message_reference: { message_id: sourceMessageId, channel_id: channelId },
    author: { id: "300", username: "nano", bot: true },
  }, true)

  const secondGroupedResponse = await resolveDiscordDeliveryTarget({
    turnTargets: [sourceTarget],
    target: 1,
  })
  assert.equal(secondGroupedResponse.referenceMessageId, null)

  ingest({
    id: "1549325035091792004",
    content: "yes! sorry!",
    author: { id: "300", username: "nano", bot: true },
  }, true)

  const thirdGroupedResponse = await resolveDiscordDeliveryTarget({
    turnTargets: [sourceTarget],
    target: 1,
  })
  assert.equal(thirdGroupedResponse.referenceMessageId, null)

  ingest({
    id: "1549325035091792005",
    content: "any update?",
    author: { id: "200", username: "callie" },
  })

  const afterNewMessage = await resolveDiscordDeliveryTarget({
    turnTargets: [sourceTarget],
    target: 1,
  })
  assert.equal(afterNewMessage.referenceMessageId, sourceMessageId)
})

test("explicit replies keep the first reference and suppress repeats in the same response group", async () => {
  initDb(":memory:")
  const channelId = "1509435403143479398"
  const sourceMessageId = "1549325035091793001"
  const sourceTarget: DiscordMessageTarget = {
    position: 1,
    channelId,
    messageId: sourceMessageId,
    itemId: sourceMessageId,
    content: "tell me more",
  }
  const ingest = (message: Record<string, unknown>, authorIsBot = false) =>
    ingestDiscordEvent({
      message: {
        channel_id: channelId,
        guild_id: "1509435403143479000",
        timestamp: new Date().toISOString(),
        ...message,
      },
      channel: { id: channelId, type: 0, name: "general" },
      guild_name: "home",
      author_is_bot: authorIsBot,
    })

  ingest({
    id: sourceMessageId,
    content: "tell me more",
    author: { id: "100", username: "belle" },
  })

  const first = await resolveDiscordDeliveryTarget({
    turnTargets: [sourceTarget],
    target: 1,
    replyMode: "explicit",
  })
  assert.equal(first.referenceMessageId, sourceMessageId)

  ingest({
    id: "1549325035091793002",
    content: "part one",
    message_reference: { message_id: sourceMessageId, channel_id: channelId },
    author: { id: "300", username: "nano", bot: true },
  }, true)

  const second = await resolveDiscordDeliveryTarget({
    turnTargets: [sourceTarget],
    target: 1,
    replyMode: "explicit",
  })
  assert.equal(second.referenceMessageId, null)

  ingest({
    id: "1549325035091793003",
    content: "part two",
    author: { id: "300", username: "nano", bot: true },
  }, true)

  const third = await resolveDiscordDeliveryTarget({
    turnTargets: [sourceTarget],
    target: 1,
    replyMode: "explicit",
  })
  assert.equal(third.referenceMessageId, null)

  ingest({
    id: "1549325035091793004",
    content: "go on",
    author: { id: "200", username: "callie" },
  })

  const afterNewMessage = await resolveDiscordDeliveryTarget({
    turnTargets: [sourceTarget],
    target: 1,
    replyMode: "explicit",
  })
  assert.equal(afterNewMessage.referenceMessageId, sourceMessageId)
})
