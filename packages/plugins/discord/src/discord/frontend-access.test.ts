import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import { config } from "@nano/runtime-api/config"
import type { Message } from "@nano/runtime-api/model"
import { createDatabase } from "@nano/plugin-persistence/db"
import { createMemoryRuntime } from "@nano/plugin-memory"
import { isDiscordMessageDispatched, markDiscordMessagesDispatched } from "./db"
import { discordRuntimeFor } from "./pipeline"
import { pruneDiscordMemory, searchDiscordMemoryEntries, searchDiscordMessages } from "./search"
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

function database(t: TestContext) {
  const db = createDatabase(":memory:").db
  t.after(() => db.close())
  return db
}

const noEmbeddings = {
  configured: () => false,
  dimensions: 3072,
  model: "test",
  embedTexts: async () => [],
}

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

function channelMessage(messageId: string, channelId: string, authorId: string, content: string) {
  return {
    message: {
      id: messageId,
      channel_id: channelId,
      guild_id: "930000000000000001",
      channel_type: 0,
      content,
      timestamp: new Date().toISOString(),
      author: { id: authorId, username: authorId },
    },
    channel: { id: channelId, type: 0, guild_id: "930000000000000001" },
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

test("frontend Discord lookups exclude the complete owner DM channel", async (t) => {
  const db = database(t)
  const oldOwner = config.discord.owner_id
  const oldWhitelist = config.discord.dm_whitelist
  config.discord.owner_id = "owner-user"
  config.discord.dm_whitelist = []
  try {
    const ownerIngest = ingestDiscordEvent(db, dm("910000000000000001", "920000000000000001", "owner-user", "owner secret marker"))
    ingestDiscordEvent(db, dm("910000000000000002", "920000000000000002", "friend-user", "friend public marker"))

    assert.throws(
      () => listDiscordBackread(db, "920000000000000001", 20, undefined, "frontend"),
      /owner DM history is unavailable/,
    )
    await assert.rejects(
      () => searchDiscordMessages(db, noEmbeddings, () => false, { channelId: "920000000000000001", messageId: "910000000000000001", runtimeKind: "frontend" }),
      /owner DM history is unavailable/,
    )
    assert.throws(
      () => setDiscordChannelNote(db, "920000000000000001", "private note", "frontend"),
      /owner DM history is unavailable/,
    )
    assert.throws(
      () => markDiscordItem(db, ownerIngest.itemId!, "seen", "", "noted", "frontend"),
      /owner DM history is unavailable/,
    )
    assert.throws(
      () => pruneDiscordMemory(db, () => false, "discord:910000000000000001", "explicit_request", undefined, "frontend"),
      /owner DM history is unavailable/,
    )
    await assert.rejects(
      () => sendDiscordMessage(db, { channelId: "920000000000000001", content: "nope", runtimeKind: "frontend" }),
      /owner DM history is unavailable/,
    )

    const inbox = listDiscordInbox(db, 20, "pending", "frontend") as Array<{ channel_id: string }>
    assert.deepEqual(inbox.map((row) => row.channel_id), ["920000000000000002"])
    const channels = listDiscordChannels(db, "frontend") as Array<{ channel_id: string }>
    assert.equal(channels.some((row) => row.channel_id === "920000000000000001"), false)
    assert.equal(channels.some((row) => row.channel_id === "920000000000000002"), true)

    const digest = buildDiscordBatchDigest(db, { maxMessages: 20, intervalMs: 60_000, runtimeKind: "frontend" })
    assert.ok(digest)
    assert.doesNotMatch(digest.content, /owner secret marker/)
    assert.match(digest.content, /friend public marker/)
    assert.match(digest.content, /target: 1/)
    assert.match(digest.content, /target: 1 id: [a-z]+-[a-z]+-[a-z]+/)
    assert.match(digest.content, /<user>[\s\S]*<\/user>/)
    assert.doesNotMatch(digest.content, /910000000000000002|920000000000000002|source_item_id|message_id/)
    assert.equal(digest.targets[0]?.messageId, "910000000000000002")
  } finally {
    config.discord.owner_id = oldOwner
    config.discord.dm_whitelist = oldWhitelist
  }
})

test("channel_poll=false excludes server channels from periodic digests", (t) => {
  const db = database(t)
  const oldChannelPoll = config.discord.channel_poll
  const oldBatchOnlyConfigured = config.discord.batch_only_configured
  const oldScanChannelIds = config.discord.scan_channel_ids
  config.discord.channel_poll = false
  config.discord.batch_only_configured = false
  config.discord.scan_channel_ids = ["920000000000000003"]
  try {
    ingestDiscordEvent(db, channelMessage(
      "910000000000000003",
      "920000000000000003",
      "server-user",
      "server channel marker",
    ))
    ingestDiscordEvent(db, dm("910000000000000004", "920000000000000004", "friend-user", "friend dm marker"))

    const digest = buildDiscordBatchDigest(db, { maxMessages: 20, intervalMs: 60_000, runtimeKind: "main" })
    assert.ok(digest)
    assert.match(digest.content, /friend dm marker/)
    assert.doesNotMatch(digest.content, /server channel marker/)
  } finally {
    config.discord.channel_poll = oldChannelPoll
    config.discord.batch_only_configured = oldBatchOnlyConfigured
    config.discord.scan_channel_ids = oldScanChannelIds
  }
})

test("periodic digests skip messages already dispatched by gateway events", (t) => {
  const db = database(t)
  const oldChannelPoll = config.discord.channel_poll
  const oldBatchOnlyConfigured = config.discord.batch_only_configured
  const oldScanChannelIds = config.discord.scan_channel_ids
  config.discord.channel_poll = true
  config.discord.batch_only_configured = true
  config.discord.scan_channel_ids = ["920000000000000005"]
  try {
    ingestDiscordEvent(db, channelMessage(
      "910000000000000005",
      "920000000000000005",
      "server-user",
      "gateway delivered marker",
    ))
    ingestDiscordEvent(db, channelMessage(
      "910000000000000006",
      "920000000000000005",
      "server-user",
      "batch only marker",
    ))
    markDiscordMessagesDispatched(db, ["910000000000000005"])

    const digest = buildDiscordBatchDigest(db, { maxMessages: 20, intervalMs: 60_000, runtimeKind: "main" })
    assert.ok(digest)
    assert.doesNotMatch(digest.content, /gateway delivered marker/)
    assert.match(digest.content, /batch only marker/)
    assert.equal(isDiscordMessageDispatched(db, "910000000000000006"), true)
  } finally {
    config.discord.channel_poll = oldChannelPoll
    config.discord.batch_only_configured = oldBatchOnlyConfigured
    config.discord.scan_channel_ids = oldScanChannelIds
  }
})

test("automatic memory recall keeps owner DM context private from frontend", async (t) => {
  const db = database(t)
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-memory-recall-"))
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true })
  })
  const oldOwner = config.discord.owner_id
  const oldWhitelist = config.discord.dm_whitelist
  config.discord.owner_id = "owner-user"
  config.discord.dm_whitelist = []
  try {
    ingestDiscordEvent(db, dm("910000000000000011", "920000000000000011", "owner-user", "violet comet launch date private dm marker"))
    ingestDiscordEvent(db, channelMessage("910000000000000012", "920000000000000012", "friend-user", "violet comet launch date allowed channel marker"))

    const memory = createMemoryRuntime({
      home,
      persistence: { getDb: () => db, vecAvailable: () => false },
      searchDiscord: (query, limit, queryVector, runtimeKind) =>
        searchDiscordMemoryEntries(db, undefined, () => false, query, limit, queryVector, runtimeKind),
    })
    const conversation: Message[] = [{ role: "user", content: "violet comet launch date", timestamp: Date.now() }]

    const frontend = await memory.buildCompletionMessages(conversation, {}, 0, { runtimeKind: "frontend" })
    const frontendContext = frontend.messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n")
    assert.match(frontendContext, /allowed channel marker/)
    assert.doesNotMatch(frontendContext, /private dm marker/)

    const main = await memory.buildCompletionMessages(conversation, {}, 0, { runtimeKind: "main" })
    assert.match(main.messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n"), /private dm marker/)
  } finally {
    config.discord.owner_id = oldOwner
    config.discord.dm_whitelist = oldWhitelist
  }
})
