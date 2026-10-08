import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import type Database from "better-sqlite3"
import { createDatabase } from "../db"
import { fromDiscord, fromDiscordMessages, fromDiscordReaction, type DiscordTriggerOptions } from "../triggers/discord"
import { discordEventImageReferences } from "./context-avatars"
import { getOrCreateDiscordFriendlyId } from "./friendly-id"
import { parseMessageRecord, renderDiscordUserMentions } from "./parse"
import { config } from "../config"

type TriggerFixture = DiscordTriggerOptions & { db: Database.Database }

function triggerOptions(t: TestContext): TriggerFixture {
  const { db } = createDatabase(":memory:")
  t.after(() => db.close())
  return { db, friendlyId: (messageId, channelId) => getOrCreateDiscordFriendlyId(db, messageId, channelId) }
}

const mentionPayload = {
  message: {
    id: "1513348392011694264",
    channel_id: "1497733589545123981",
    guild_id: "1497733589545123980",
    content: "hey <@123> and <@!456>",
    timestamp: "2026-06-15T12:00:00.000Z",
    author: { id: "789", username: "ana" },
    mentions: [
      { id: "123", username: "dawn" },
      { id: "456", global_name: "nova", username: "novabot" },
    ],
  },
  channel: {
    id: "1497733589545123981",
    type: 0,
    name: "mira",
    guild_id: "1497733589545123980",
  },
  guild_name: "home",
}

test("discord user mentions render names instead of ids", (t) => {
  const options = triggerOptions(t)
  assert.equal(renderDiscordUserMentions(mentionPayload, "hey <@123> and <@!456>"), "hey @dawn and @nova")

  const record = parseMessageRecord(mentionPayload)
  assert.equal(record?.content, "hey @dawn and @nova")

  const event = fromDiscord(mentionPayload, options)
  assert.match(event.content, /hey @dawn and @nova/)
  assert.match(event.content, /<user>\nhey @dawn and @nova\n<\/user>/)
  assert.doesNotMatch(event.content, /timestamp:[^\n]+\n\n<user>/)
  assert.match(event.content, /^target: 1$/m)
  assert.match(event.content, /^id: [a-z]+-[a-z]+-[a-z]+$/m)
  assert.match(event.discordTargets?.[0]?.friendlyId ?? "", /^[a-z]+-[a-z]+-[a-z]+$/)
  assert.doesNotMatch(event.content, /1513348392011694264|1497733589545123981|source_item_id|message_id/)
  assert.doesNotMatch(event.content, /<@!?/)
})

test("discord server nicknames are preferred and rendered correctly", (t) => {
  const options = triggerOptions(t)
  const nicknamePayload = {
    message: {
      id: "1513348392011694264",
      channel_id: "1497733589545123981",
      guild_id: "1497733589545123980",
      content: "hey <@123> and <@!456>",
      timestamp: "2026-06-15T12:00:00.000Z",
      author: { id: "789", username: "ana", global_name: "Ana Global" },
      member: { nickname: "Ana Server Nick", display_name: "Ana Server Nick" },
      mentions: [
        { id: "123", username: "dawn", global_name: "Dawn Global", nickname: "Dawn Server Nick", display_name: "Dawn Server Nick" },
        { id: "456", username: "novabot", global_name: "Nova Global", nickname: "Nova Server Nick", display_name: "Nova Server Nick" },
      ],
    },
    channel: {
      id: "1497733589545123981",
      type: 0,
      name: "mira",
      guild_id: "1497733589545123980",
    },
    guild_name: "home",
  }

  const record = parseMessageRecord(nicknamePayload)
  assert.equal(record?.authorUsername, "Ana Server Nick")
  assert.equal(record?.content, "hey @Dawn Server Nick and @Nova Server Nick")

  const event = fromDiscord(nicknamePayload, options)
  assert.match(event.content, /@Ana Server Nick/)
  assert.match(event.content, /hey @Dawn Server Nick and @Nova Server Nick/)
  assert.match(event.content, /<user>\nhey @Dawn Server Nick and @Nova Server Nick\n<\/user>/)
})

test("a debounced DM burst delivers every message in arrival order", (t) => {
  const options = triggerOptions(t)
  const dm = (id: string, content: string, timestamp: string) => ({
    message: {
      id,
      channel_id: "dm-123",
      guild_id: null,
      content,
      timestamp,
      author: { id: "789", username: "ana" },
    },
    channel: { id: "dm-123", type: 1 },
    is_dm: true,
  })

  const event = fromDiscordMessages([
    dm("message-1", "first thought", "2026-06-15T12:00:00.000Z"),
    dm("message-2", "second thought", "2026-06-15T12:00:03.000Z"),
  ], options)

  assert.ok(event.content.indexOf("first thought") < event.content.indexOf("second thought"))
  assert.match(event.content, /^target: 1$/m)
  assert.match(event.content, /^target: 2$/m)
  assert.equal([...event.content.matchAll(/^id: [a-z]+-[a-z]+-[a-z]+$/gm)].length, 2)
  assert.equal([...event.content.matchAll(/^<user>$/gm)].length, 2)
  assert.equal([...event.content.matchAll(/^<\/user>$/gm)].length, 2)
  assert.equal([...event.content.matchAll(/^action: This is a direct message\. Reply if it needs a response\.$/gm)].length, 2)
  assert.doesNotMatch(event.content, /message-[12]|source_item_id|message_id/)
  assert.deepEqual(event.discordTargets?.map(({ position, channelId, messageId, content }) => ({ position, channelId, messageId, content })), [
    { position: 1, channelId: "dm-123", messageId: "message-1", content: "first thought" },
    { position: 2, channelId: "dm-123", messageId: "message-2", content: "second thought" },
  ])
  assert.deepEqual(event.raw, [
    dm("message-1", "first thought", "2026-06-15T12:00:00.000Z"),
    dm("message-2", "second thought", "2026-06-15T12:00:03.000Z"),
  ])
})

test("reaction notifications target the original message and attach custom emoji through the shared bitmap path", (t) => {
  assert.equal(config.discord.wake_on_reaction, true)
  const options = triggerOptions(t)
  const event = fromDiscordReaction({
    message: {
      id: "1513348392011694999",
      channel_id: "1497733589545123981",
      guild_id: "1497733589545123980",
      content: "ship it",
      timestamp: "2026-06-15T12:00:00.000Z",
      author: { id: "789", username: "ana", global_name: "Ana" },
    },
    channel: {
      id: "1497733589545123981",
      type: 0,
      name: "mira",
      guild_id: "1497733589545123980",
    },
    guild_name: "home",
    reactor: { id: "456", username: "nova", global_name: "Nova", bot: false },
    emoji: { id: "523456789012345678", name: "party", animated: true },
    reacted_at: "2026-06-15T12:01:00.000Z",
  }, options)

  assert.match(event.content, /@Nova/)
  assert.match(event.content, /reacted with <a:party:523456789012345678> to @Ana's message:/)
  assert.match(event.content, /ship it/)
  assert.equal(event.discordTargets?.[0]?.messageId, "1513348392011694999")
  assert.equal(event.discordTargets?.[0]?.content, "ship it")
  assert.deepEqual(
    discordEventImageReferences(options.db!, event).map((ref) => ref.kind === "discord-emoji" && [ref.emojiId, ref.animated]),
    [["523456789012345678", true]],
  )
})
