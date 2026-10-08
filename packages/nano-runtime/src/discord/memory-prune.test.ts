import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { MEMORY_EMBEDDING_DIMENSIONS, createDatabase } from "../db"
import { upsertDiscordMessage, upsertInboxItem } from "./db"
import { pruneDiscordMemory, searchDiscordMemoryEntries, type DiscordEmbeddings } from "./search"

test("Discord vector memories are searchable by stable id and durably prunable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-discord-memory-prune-"))
  const home = path.join(root, "home")
  const { db, vecAvailable } = createDatabase(path.join(root, "nano.db"), home)
  t.after(async () => {
    if (db.open) db.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  if (!vecAvailable) return

  const embeddings: DiscordEmbeddings = {
    configured: () => false,
    dimensions: MEMORY_EMBEDDING_DIMENSIONS,
    model: "test",
    embedTexts: async () => [],
  }
  const available = () => vecAvailable
  db.prepare(`
    insert into discord_channels (
      channel_id, guild_id, channel_name, guild_name, is_dm, configured,
      first_seen_at, last_seen_at, raw_json
    ) values ('456', '789', 'garden', 'Coral', 0, 1, datetime('now'), datetime('now'), '{}')
  `).run()
  db.prepare(`
    insert into discord_messages (
      message_id, channel_id, guild_id, author_id, author_username, content,
      created_at, is_dm, mentions_bot, is_from_bot, first_seen_at, last_seen_at, raw_json
    ) values (
      '123', '456', '789', '42', 'callie', 'the launch date is definitely Tuesday',
      '2026-09-07T12:00:00.000Z', 0, 0, 0, datetime('now'), datetime('now'), '{}'
    )
  `).run()
  db.prepare(`
    insert into discord_message_embedding_meta (message_id, model, dimensions, content_hash)
    values ('123', 'test', ?, 'hash')
  `).run(MEMORY_EMBEDDING_DIMENSIONS)
  db.prepare(`
    insert into discord_items (
      item_id, message_id, bucket, status, action_taken, first_seen_at, last_seen_at
    ) values ('123', '123', 'mention', 'pending', 'none', datetime('now'), datetime('now'))
  `).run()

  const vector = Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, (_, index) => index === 0 ? 1 : 0)
  db.prepare("insert into discord_message_vec(rowid, embedding) values (?, ?)")
    .run(123n, new Float32Array(vector))

  const before = await searchDiscordMemoryEntries(db, embeddings, available, "launch date", 5, vector)
  assert.equal(before.length, 1)
  assert.equal(before[0]?.id, "discord:123")
  assert.equal(before[0]?.kind, "discord")
  assert.equal(before[0]?.messageId, "123")
  assert.ok(before[0]?.source.includes("Coral / #garden"))

  const pruned = pruneDiscordMemory(db, available, "discord:123", "surfaced_stale", "The launch moved to Thursday.")
  assert.equal(pruned.ok, true)
  assert.equal(pruned.id, "discord:123")
  assert.equal(pruned.already_pruned, false)

  const after = await searchDiscordMemoryEntries(db, embeddings, available, "launch date", 5, vector)
  assert.deepEqual(after, [])
  assert.equal(db.prepare("select 1 from discord_messages where message_id = '123'").get(), undefined)
  assert.equal(db.prepare("select 1 from discord_items where message_id = '123'").get(), undefined)
  assert.ok(db.prepare("select 1 from discord_memory_prunes where message_id = '123'").get())
  assert.equal(db.prepare("select 1 from discord_message_embedding_meta where message_id = '123'").get(), undefined)
  assert.equal(db.prepare("select 1 from discord_message_vec where rowid = 123").get(), undefined)

  upsertDiscordMessage(db, {
    messageId: "123",
    channelId: "456",
    guildId: "789",
    channelType: 0,
    authorId: "42",
    authorUsername: "callie",
    content: "the launch date is definitely Tuesday",
    createdAt: "2026-09-07T12:00:00.000Z",
    isDm: false,
    isFromBot: false,
    isFromSelf: false,
    mentionsBot: false,
    rawJson: "{}",
  })
  upsertInboxItem(db, "123", "mention")
  assert.equal(db.prepare("select 1 from discord_messages where message_id = '123'").get(), undefined)
  assert.equal(db.prepare("select 1 from discord_items where message_id = '123'").get(), undefined)

  const again = pruneDiscordMemory(db, available, "discord:123", "explicit_request")
  assert.equal(again.already_pruned, true)
  assert.equal(again.reason, "surfaced_stale")
  assert.throws(
    () => pruneDiscordMemory(db, available, "memory:123", "explicit_request"),
    /only accepts a discord/,
  )
})

test("keyword Discord recall without embeddings remains durably prunable", async (t) => {
  const { db } = createDatabase(":memory:")
  t.after(() => db.close())
  upsertDiscordMessage(db, {
    messageId: "123", channelId: "456", channelType: 0,
    guildId: null,
    authorId: "42", authorUsername: "callie", content: "launch date Tuesday",
    createdAt: "2026-09-07T12:00:00.000Z", isDm: false, isFromBot: false,
    isFromSelf: false, mentionsBot: false, rawJson: "{}",
  })
  const results = await searchDiscordMemoryEntries(db, undefined, () => false, "launch date", 5)
  assert.equal(results[0]?.id, "discord:123")
  const pruned = pruneDiscordMemory(db, () => false, results[0]!.id, "surfaced_stale")
  assert.equal(pruned.ok, true)
  assert.deepEqual(await searchDiscordMemoryEntries(db, undefined, () => false, "launch date", 5), [])
  assert.equal(pruneDiscordMemory(db, () => false, "discord:123", "explicit_request").reason, "surfaced_stale")
})
