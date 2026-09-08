import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("Discord vector memories are searchable by stable id and durably prunable", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-discord-memory-prune-"))
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true })
  })

  const moduleUrl = (filePath: string) => new URL(filePath, import.meta.url).href
  const script = `
    import assert from "node:assert/strict"

    const [{ initDb, getDb, isVecAvailable, MEMORY_EMBEDDING_DIMENSIONS }, discordSearch] =
      await Promise.all([
        import(${JSON.stringify(moduleUrl("../db.ts"))}),
        import(${JSON.stringify(moduleUrl("./search.ts"))}),
      ])

    initDb()
    if (!isVecAvailable()) process.exit(0)
    const db = getDb()
    db.prepare(\`
      insert into discord_channels (
        channel_id, guild_id, channel_name, guild_name, is_dm, configured,
        first_seen_at, last_seen_at, raw_json
      ) values ('456', '789', 'garden', 'Coral', 0, 1, datetime('now'), datetime('now'), '{}')
    \`).run()
    db.prepare(\`
      insert into discord_messages (
        message_id, channel_id, guild_id, author_id, author_username, content,
        created_at, is_dm, mentions_bot, is_from_bot, first_seen_at, last_seen_at, raw_json
      ) values (
        '123', '456', '789', '42', 'callie', 'the launch date is definitely Tuesday',
        '2026-09-07T12:00:00.000Z', 0, 0, 0, datetime('now'), datetime('now'), '{}'
      )
    \`).run()
    db.prepare(\`
      insert into discord_message_embedding_meta (message_id, model, dimensions, content_hash)
      values ('123', 'test', ?, 'hash')
    \`).run(MEMORY_EMBEDDING_DIMENSIONS)
    db.prepare(\`
      insert into discord_items (
        item_id, message_id, bucket, status, action_taken, first_seen_at, last_seen_at
      ) values ('123', '123', 'mention', 'pending', 'none', datetime('now'), datetime('now'))
    \`).run()

    const vector = Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, (_, index) => index === 0 ? 1 : 0)
    db.prepare("insert into discord_message_vec(rowid, embedding) values (?, ?)")
      .run(123n, new Float32Array(vector))

    const before = await discordSearch.searchDiscordMemoryEntries("launch date", 5, vector)
    assert.equal(before.length, 1)
    assert.equal(before[0].id, "discord:123")
    assert.equal(before[0].kind, "discord")
    assert.equal(before[0].messageId, "123")
    assert.ok(before[0].source.includes("Coral / #garden"))

    const pruned = discordSearch.pruneDiscordMemory(
      before[0].id,
      "surfaced_stale",
      "The launch moved to Thursday.",
    )
    assert.equal(pruned.ok, true)
    assert.equal(pruned.id, "discord:123")
    assert.equal(pruned.already_pruned, false)

    const after = await discordSearch.searchDiscordMemoryEntries("launch date", 5, vector)
    assert.deepEqual(after, [])
    assert.equal(db.prepare("select 1 from discord_messages where message_id = '123'").get(), undefined)
    assert.equal(db.prepare("select 1 from discord_items where message_id = '123'").get(), undefined)
    assert.ok(db.prepare("select 1 from discord_memory_prunes where message_id = '123'").get())
    assert.equal(db.prepare("select 1 from discord_message_embedding_meta where message_id = '123'").get(), undefined)
    assert.equal(db.prepare("select 1 from discord_message_vec where rowid = 123").get(), undefined)

    const discordDb = await import(${JSON.stringify(moduleUrl("./db.ts"))})
    discordDb.upsertDiscordMessage({
      messageId: "123",
      channelId: "456",
      guildId: "789",
      channelType: 0,
      authorId: "42",
      authorUsername: "callie",
      content: "the launch date is definitely Tuesday",
      createdAt: "2026-09-07T12:00:00.000Z",
      isDm: false,
      mentionsBot: false,
      isFromBot: false,
      rawJson: "{}",
    })
    discordDb.upsertInboxItem("123", "mention")
    assert.equal(db.prepare("select 1 from discord_messages where message_id = '123'").get(), undefined)
    assert.equal(db.prepare("select 1 from discord_items where message_id = '123'").get(), undefined)

    const again = discordSearch.pruneDiscordMemory("discord:123", "explicit_request")
    assert.equal(again.already_pruned, true)
    assert.equal(again.reason, "surfaced_stale")
    assert.throws(
      () => discordSearch.pruneDiscordMemory("memory:123", "explicit_request"),
      /only accepts a discord/,
    )
  `

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NANO_HOME: home,
        DISCORD_SEARCH_CATCHUP_BATCH_SIZE: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf-8").on("data", (chunk) => { stdout += chunk })
    child.stderr.setEncoding("utf-8").on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })

  assert.equal(result.code, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"))
})
