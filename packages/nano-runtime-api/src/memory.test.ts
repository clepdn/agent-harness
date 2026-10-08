import test from "node:test"
import assert from "node:assert/strict"
import type { Message } from "./types"
import {
  __memoryTest,
  memoryQueryForUserMessage,
  resolveAliases,
  searchTokens,
} from "./memory/index"

test("latestMemoryRecallQuery falls back past scheduled heartbeat", () => {
  const t = Date.now()
  const conversation: Message[] = [
    { role: "user", content: "what did we talk about when lisya was buying monero", timestamp: t },
    { role: "assistant", content: [{ type: "text", text: "..." }], api: "openai-completions", provider: "openai", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: t },
    { role: "user", content: "Scheduled heartbeat.", timestamp: t },
  ]

  assert.equal(
    __memoryTest.latestMemoryRecallQuery(conversation),
    "what did we talk about when lisya was buying monero",
  )
})

test("memoryQueryForUserMessage extracts structured parts from discord batch", () => {
  const batch = `[user/discord] [discord batch] 2026-05-01T03:10:50.162Z -> 2026-05-01T03:11:22.198Z
new_messages=1 channels=1 pending_inbox=0 scope=configured+dm
auto_seen_timeout=10m auto_demoted=0
channel_flag_repairs=0
channel messages are context, not direct requests. replying is optional; use judgment.

recent messages:
- source_item_id=1499679672404021248 [channel/staying up till 1 billion oclock/#nano] [2026-05-01 03:11:14.553Z] @meowskullz: awa

pending preview:
- source_item_id=1499679672404021248 bucket=mention [channel/staying up till 1 billion oclock/#nano] [2026-05-01 03:11:14.553Z] @meowskullz: awa`

  assert.deepEqual(memoryQueryForUserMessage(batch), {
    sender: "meowskullz",
    source: "channel/staying up till 1 billion oclock/#nano",
    body: "awa",
  })
})

test("latestMemoryRecallQuery skips ambient discord batch without items", () => {
  const batch = `[user/discord] [discord batch] 2026-05-01T03:10:50.162Z -> 2026-05-01T03:11:22.198Z
new_messages=1 channels=1 pending_inbox=0 scope=configured+dm

recent messages:
- (none)

pending preview:
- (none)`

  const t = Date.now()
  const conversation: Message[] = [
    { role: "user", content: "what did we talk about when lisya was buying monero", timestamp: t },
    { role: "assistant", content: [{ type: "text", text: "..." }], api: "openai-completions", provider: "openai", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: t },
    { role: "user", content: batch, timestamp: t },
  ]

  assert.equal(
    __memoryTest.latestMemoryRecallQuery(conversation),
    "what did we talk about when lisya was buying monero",
  )
})

test("memoryQueryForUserMessage processes discord batch recent messages when pending preview is empty", () => {
  const batch = `[user/discord] [discord batch] 2026-05-01T03:10:50.162Z -> 2026-05-01T03:11:22.198Z
new_messages=1 channels=1 pending_inbox=0 scope=configured+dm

recent messages:
- source_item_id=1499680000000000000 [channel/meowskullz's server/#ai-sister-yap] [2026-05-01 08:01:35.639Z] @rose: foxie emoji

pending preview:
- (none)`

  assert.deepEqual(memoryQueryForUserMessage(batch), {
    sender: "rose",
    source: "channel/meowskullz's server/#ai-sister-yap",
    body: "foxie emoji",
  })
})

test("memoryQueryForUserMessage unwraps user tags in a discord batch", () => {
  const batch = `[discord batch] Sep 16, 2026, 1:00 PM EDT -> Sep 16, 2026, 1:01 PM EDT

recent messages:
- target: 1 id: bamboo-bell-basket [channel/home/#general] [Sep 16, 2026, 1:00 PM EDT] @rose:
  <user>
  hello from the batch
  </user>

pending preview:
- (none)`

  assert.deepEqual(memoryQueryForUserMessage(batch), {
    sender: "rose",
    source: "channel/home/#general",
    body: "hello from the batch",
  })
})

test("memoryQueryForUserMessage parses discord DM envelope into parts", () => {
  const dm = `[discord/dm] @meowskullz
context: DM 1234567890
message_id: 9999
timestamp: 2026-05-01T00:00:00Z
action: This is a direct message. Reply if it needs a response.
<user>
thanks
</user>`

  const parts = memoryQueryForUserMessage(dm)
  assert.equal(parts.sender, "meowskullz")
  assert.equal(parts.source, "DM")
  assert.equal(parts.body, "thanks")
})

test("resolveAliases follows transitive mappings without cycles", () => {
  const map = {
    meowskullz: ["ana"],
    ana: ["ana_canonical"],
    foo: ["meowskullz"],
  }
  assert.deepEqual(resolveAliases("meowskullz", map), ["ana", "ana_canonical"])
  assert.deepEqual(resolveAliases("foo", map), ["meowskullz", "ana", "ana_canonical"])
  assert.deepEqual(resolveAliases(null, map), [])
})

test("searchTokens keeps meaningful body terms", () => {
  const tokens = searchTokens("staying up till 1 billion oclock awa")
  for (const meaningful of ["staying", "billion", "oclock", "awa"]) {
    assert.ok(tokens.includes(meaningful))
  }
  assert.equal(tokens.includes("up"), false)
})
