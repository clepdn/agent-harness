import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Database from "better-sqlite3"
import { createDatabase } from "./db"
import { createPersistenceService } from "./plugins/persistence"

interface MessageContentRow {
  readonly content: string
}

interface RuntimeKindRow {
  readonly runtime_kind: string
}

interface DispatchedAtRow {
  readonly dispatched_at: string | null
}

interface StateRevisionRow {
  readonly path: string
  readonly content: string
  readonly source: string
}

test("database factory preserves conversation data across reopen and uses the explicit home", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-storage-db-"))
  const home = path.join(root, "managed-home")
  const dbPath = path.join(root, "data", "nano.db")
  t.after(async () => fs.rm(root, { recursive: true, force: true }))

  const first = createDatabase(dbPath, home)
  const result = first.db.prepare("insert into conversations (startedAt, source, tokens) values (?, ?, ?)").run("2026-10-07T00:00:00.000Z", "test", 7)
  const id = Number(result.lastInsertRowid)
  first.db.prepare("insert into messages (convId, role, content, toolCalls) values (?, ?, ?, ?)")
    .run(id, "user", "persisted", JSON.stringify({ call: true }))
  first.db.close()

  const reopened = createDatabase(dbPath, home)
  t.after(() => reopened.db.close())
  assert.deepEqual(reopened.db.prepare("select source, tokens from conversations where id = ?").get(id), { source: "test", tokens: 7 })
  assert.deepEqual(reopened.db.prepare("select role, content, toolCalls from messages where convId = ?").get(id), {
    role: "user", content: "persisted", toolCalls: JSON.stringify({ call: true }),
  })
  assert.equal(await fs.stat(path.join(root, "data", "nano.db")).then(() => true), true)
  assert.equal(await fs.stat(path.join(home, "nano.db")).then(() => true).catch(() => false), false)
})

test("database factory preserves legacy durable rows while applying additive columns", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-storage-legacy-"))
  const dbPath = path.join(root, "nano.db")
  t.after(async () => fs.rm(root, { recursive: true, force: true }))

  const legacy = new Database(dbPath)
  legacy.exec(`
    create table conversations (id integer primary key autoincrement, startedAt text not null, source text not null, tokens integer not null default 0);
    insert into conversations (startedAt, source, tokens) values ('2026-01-01T00:00:00.000Z', 'legacy', 9);
    create table messages (id integer primary key autoincrement, convId integer not null references conversations(id), role text not null, content text not null, toolCalls text, toolCallId text, createdAt text not null default (datetime('now')));
    insert into messages (convId, role, content) values (1, 'user', 'kept message');
    create table context_messages (id text primary key, role text not null, content_json text not null, content_text text not null, first_seen_at text not null, source text not null);
    insert into context_messages values ('legacy-message', 'user', '"kept context"', 'kept context', '2026-01-01T00:00:00.000Z', 'legacy');
    create table context_summaries (id text primary key, summary_text text not null, method text not null, created_at text not null);
    insert into context_summaries values ('legacy-summary', 'kept summary', 'legacy', '2026-01-01T00:00:00.000Z');
    create table discord_messages (message_id text primary key, channel_id text not null, guild_id text, channel_type integer, author_id text, author_username text, content text not null default '', created_at text not null, is_dm integer not null default 0, mentions_bot integer not null default 0, is_from_bot integer not null default 0, first_seen_at text not null, last_seen_at text not null, raw_json text not null);
    insert into discord_messages (message_id, channel_id, created_at, first_seen_at, last_seen_at, raw_json) values ('legacy-discord', 'channel', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}');
  `)
  legacy.close()

  const migrated = createDatabase(dbPath, root)
  t.after(() => migrated.db.close())
  assert.deepEqual(migrated.db.prepare("select source, tokens from conversations where id = 1").get(), { source: "legacy", tokens: 9 })
  assert.equal(migrated.db.prepare<unknown[], MessageContentRow>("select content from messages where id = 1").get()?.content, "kept message")
  assert.equal(migrated.db.prepare<unknown[], RuntimeKindRow>("select runtime_kind from context_messages where id = 'legacy-message'").get()?.runtime_kind, "main")
  assert.equal(migrated.db.prepare<unknown[], RuntimeKindRow>("select runtime_kind from context_summaries where id = 'legacy-summary'").get()?.runtime_kind, "main")
  assert.equal(migrated.db.prepare<unknown[], DispatchedAtRow>("select dispatched_at from discord_messages where message_id = 'legacy-discord'").get()?.dispatched_at, null)
})

test("persistence snapshots tracked state before publishing the initialized service and rejects calls after close", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-state-history-"))
  const home = path.join(root, "home")
  await fs.mkdir(path.join(home, "memories"), { recursive: true })
  await fs.writeFile(path.join(home, "soul.md"), "startup soul")
  await fs.writeFile(path.join(home, "memories", "core.md"), "startup core")
  t.after(async () => fs.rm(root, { recursive: true, force: true }))

  const service = createPersistenceService({ path: path.join(root, "history.db"), home })
  t.after(() => service.close())
  await service.init()
  assert.deepEqual(service.getDb().prepare<unknown[], StateRevisionRow>("select path, content, source from state_revisions order by path").all(), [
    { path: "memories/core.md", content: "startup core", source: "external" },
    { path: "soul.md", content: "startup soul", source: "external" },
  ])
  await service.close()
  assert.throws(() => service.getDb(), /closed/)
  await assert.rejects(async () => service.saveSession({ version: 1, messages: [], toolCatalog: [], toolCatalogEpoch: 1, toolCatalogFingerprint: "" }), /closed/)
  assert.throws(() => service.archiveContextMessages([], "closed"), /closed/)
  assert.throws(() => service.publishWorkerEvent("runner.status", { presence: "awake" }), /closed/)
})

test("concurrent persistence initialization shares startup and rejects path changes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-storage-init-"))
  t.after(async () => fs.rm(root, { recursive: true, force: true }))
  const service = createPersistenceService({ path: path.join(root, "nano.db"), home: path.join(root, "home") })
  t.after(() => service.close())
  await Promise.all([service.init(), service.init()])
  await assert.rejects(service.init(path.join(root, "other.db")), /different path/)
})
