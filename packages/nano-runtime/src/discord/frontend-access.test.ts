import assert from "node:assert/strict"
import test from "node:test"
import { config } from "../config"
import { initDb } from "../db"
import { discordRuntimeFor } from "./pipeline"
import { pruneDiscordMemory, searchDiscordMessages } from "./search"
import {
  buildDiscordBatchDigest,
  ingestDiscordEvent,
  listDiscordBackread,
  listDiscordChannels,
  listDiscordInbox,
  markDiscordItem,
  sendDiscordMessage,
  setDiscordChannelNote,
} from "./state"

function dm(messageId: string, channelId: string, authorId: string, content: string) {
  return {
    message: {
      id: messageId,
      channel_id: channelId,
      content,
      timestamp: new Date().toISOString(),
      author: { id: authorId, username: authorId },
    },
    channel: { id: channelId, type: 1 },
    is_dm: true,
  }
}

test("frontend routing reserves only owner-authored DMs for main", () => {
  const oldEnable = config.frontend.enable
  const oldOwner = config.discord.owner_id
  config.frontend.enable = true
  config.discord.owner_id = "owner-user"
  try {
    assert.equal(discordRuntimeFor({ stored: true, isNew: true, isDm: true, authorId: "owner-user" }), "main")
    assert.equal(discordRuntimeFor({ stored: true, isNew: true, isDm: true, authorId: "someone-else" }), "frontend")
    assert.equal(discordRuntimeFor({ stored: true, isNew: true, isDm: false, authorId: "owner-user" }), "frontend")
  } finally {
    config.frontend.enable = oldEnable
    config.discord.owner_id = oldOwner
  }
})

test("frontend Discord lookups exclude the complete owner DM channel", async () => {
  initDb(":memory:")
  const oldOwner = config.discord.owner_id
  const oldWhitelist = config.discord.dm_whitelist
  config.discord.owner_id = "owner-user"
  config.discord.dm_whitelist = []
  try {
    const ownerIngest = ingestDiscordEvent(dm("910000000000000001", "920000000000000001", "owner-user", "owner secret marker"))
    ingestDiscordEvent(dm("910000000000000002", "920000000000000002", "friend-user", "friend public marker"))

    assert.throws(
      () => listDiscordBackread("920000000000000001", 20, undefined, "frontend"),
      /owner DM history is unavailable/,
    )
    await assert.rejects(
      () => searchDiscordMessages({ channelId: "920000000000000001", messageId: "910000000000000001", runtimeKind: "frontend" }),
      /owner DM history is unavailable/,
    )
    assert.throws(
      () => setDiscordChannelNote("920000000000000001", "private note", "frontend"),
      /owner DM history is unavailable/,
    )
    assert.throws(
      () => markDiscordItem(ownerIngest.itemId!, "seen", "", "noted", "frontend"),
      /owner DM history is unavailable/,
    )
    assert.throws(
      () => pruneDiscordMemory("discord:910000000000000001", "explicit_request", undefined, "frontend"),
      /owner DM history is unavailable/,
    )
    await assert.rejects(
      () => sendDiscordMessage({ channelId: "920000000000000001", content: "nope", runtimeKind: "frontend" }),
      /owner DM history is unavailable/,
    )

    const inbox = listDiscordInbox(20, "pending", "frontend") as Array<{ channel_id: string }>
    assert.deepEqual(inbox.map((row) => row.channel_id), ["920000000000000002"])
    const channels = listDiscordChannels("frontend") as Array<{ channel_id: string }>
    assert.equal(channels.some((row) => row.channel_id === "920000000000000001"), false)
    assert.equal(channels.some((row) => row.channel_id === "920000000000000002"), true)

    const digest = buildDiscordBatchDigest({ maxMessages: 20, intervalMs: 60_000, runtimeKind: "frontend" })
    assert.ok(digest)
    assert.doesNotMatch(digest.content, /owner secret marker/)
    assert.match(digest.content, /friend public marker/)
    assert.match(digest.content, /target: 1/)
    assert.doesNotMatch(digest.content, /910000000000000002|920000000000000002|source_item_id|message_id/)
    assert.equal(digest.targets[0]?.messageId, "910000000000000002")
  } finally {
    config.discord.owner_id = oldOwner
    config.discord.dm_whitelist = oldWhitelist
  }
})
