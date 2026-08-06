import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { initDb } from "../db"
import { ingestDiscordEvent } from "./state"
import { config } from "../config"

test("discord dm whitelist tests", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nano-test-state-"))
  const testDbPath = path.join(tempDir, "nano.db")

  // The whitelist and bot identity are [discord] config, not environment.
  const discord = config.discord as { dm_whitelist: string[]; bot_user_id: string }
  const originalWhitelist = discord.dm_whitelist
  const originalBotId = discord.bot_user_id

  try {
    initDb(testDbPath)

    discord.bot_user_id = "930000000000000001"

    // 1. Whitelist not set - DM from userA should be ingested
    discord.dm_whitelist = []
    const dmFromUserA = {
      message: {
        id: "900000000000000001",
        channel_id: "910000000000000001",
        content: "hello",
        timestamp: "2026-06-15T12:00:00.000Z",
        author: { id: "920000000000000001", username: "alice" },
      },
      channel: {
        id: "910000000000000001",
        type: 1,
      },
    }
    const res1 = ingestDiscordEvent(dmFromUserA)
    assert.equal(res1.stored, true, "Should store DM when whitelist is not set")
    assert.equal(res1.bucket, "dm")

    // 2. Whitelist is set (userA, userB) - DM from userA should be ingested
    discord.dm_whitelist = ["920000000000000001", "920000000000000002"]
    const dmFromUserA_2 = {
      message: {
        id: "900000000000000002",
        channel_id: "910000000000000001",
        content: "hello again",
        timestamp: "2026-06-15T12:01:00.000Z",
        author: { id: "920000000000000001", username: "alice" },
      },
      channel: {
        id: "910000000000000001",
        type: 1,
      },
    }
    const res2 = ingestDiscordEvent(dmFromUserA_2)
    assert.equal(res2.stored, true, "Should store DM when user is whitelisted")
    assert.equal(res2.bucket, "dm")

    // 3. Whitelist is set (userA, userB) - DM from userC should be ignored
    const dmFromUserC = {
      message: {
        id: "900000000000000003",
        channel_id: "910000000000000002",
        content: "hey",
        timestamp: "2026-06-15T12:02:00.000Z",
        author: { id: "920000000000000003", username: "charlie" },
      },
      channel: {
        id: "910000000000000002",
        type: 1,
      },
    }
    const res3 = ingestDiscordEvent(dmFromUserC)
    assert.equal(res3.stored, false, "Should not store DM when user is not whitelisted")
    assert.equal(res3.reason, "ignored DM: sender is not in [discord].dm_whitelist")

    // 4. Whitelist is set (userA, userB) - DM from bot itself (self) should still be stored (for history)
    const dmFromSelf = {
      message: {
        id: "900000000000000004",
        channel_id: "910000000000000001",
        content: "bot reply",
        timestamp: "2026-06-15T12:03:00.000Z",
        author: { id: "930000000000000001", username: "mybot" },
      },
      channel: {
        id: "910000000000000001",
        type: 1,
      },
    }
    const res4 = ingestDiscordEvent(dmFromSelf)
    assert.equal(res4.stored, true, "Should store self DM even if bot is not in whitelist")
    assert.equal(res4.isFromSelf, true)

    // 5. Channel message (non-DM) from non-whitelisted user should still be stored/ingested normally
    const channelMsgFromUserC = {
      message: {
        id: "900000000000000005",
        channel_id: "910000000000000003",
        guild_id: "940000000000000001",
        content: "public text",
        timestamp: "2026-06-15T12:04:00.000Z",
        author: { id: "920000000000000003", username: "charlie" },
      },
      channel: {
        id: "910000000000000003",
        type: 0,
        guild_id: "940000000000000001",
      },
    }
    const res5 = ingestDiscordEvent(channelMsgFromUserC)
    assert.equal(res5.stored, true, "Should store non-DM channel messages even if sender is not whitelisted")

  } finally {
    discord.dm_whitelist = originalWhitelist
    discord.bot_user_id = originalBotId
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})
