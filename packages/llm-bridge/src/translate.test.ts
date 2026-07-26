import { test } from "node:test"
import assert from "node:assert/strict"
import { oaiContentToText, oaiMessagesToContext } from "./translate"
import { __anthropicDirectTest } from "./anthropic-direct"

const { oaiToAnthropicMessages, oaiContentToBlocks, applyCacheBreakpoints } = __anthropicDirectTest

type AnyBlock = { cache_control?: unknown }
const lastBlock = (m: { content: unknown }): AnyBlock => {
  const c = m.content as AnyBlock[]
  return c[c.length - 1]!
}
const countBreakpoints = (
  system: AnyBlock[],
  messages: Array<{ content: unknown }>,
  tools: AnyBlock[],
): number => {
  let n = 0
  for (const t of tools) if (t.cache_control) n++
  for (const s of system) if (s.cache_control) n++
  for (const m of messages) for (const b of m.content as AnyBlock[]) if (b.cache_control) n++
  return n
}

test("oaiContentToText extracts text from string and array-of-parts content", () => {
  assert.equal(oaiContentToText("hello"), "hello")
  assert.equal(oaiContentToText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "ab")
  assert.equal(oaiContentToText([{ type: "image_url", image_url: { url: "x" } }]), "")
  assert.equal(oaiContentToText(null), "")
})

test("anthropic: array-form user content is NOT dropped (regression for empty messages 400)", () => {
  const { messages } = oaiToAnthropicMessages([
    { role: "system", content: [{ type: "text", text: "be terse" }] },
    { role: "user", content: [{ type: "text", text: "hi there" }] },
  ])
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0], { role: "user", content: [{ type: "text", text: "hi there" }] })
})

test("anthropic: plain-string user content still works", () => {
  const { messages } = oaiToAnthropicMessages([{ role: "user", content: "plain" }])
  assert.deepEqual(messages[0], { role: "user", content: [{ type: "text", text: "plain" }] })
})

test("oaiContentToBlocks converts image_url parts to anthropic image blocks", () => {
  const dataUrl = "data:image/png;base64,QUJD"
  const blocks = oaiContentToBlocks([
    { type: "text", text: "look:" },
    { type: "image_url", image_url: { url: dataUrl } },
    { type: "image_url", image_url: { url: "https://example.com/a.png" } },
  ])
  assert.deepEqual(blocks[0], { type: "text", text: "look:" })
  assert.deepEqual(blocks[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } })
  assert.deepEqual(blocks[2], { type: "image", source: { type: "url", url: "https://example.com/a.png" } })
})

test("cache safety: translated content prefix is byte-stable as the conversation grows", () => {
  // This is the crux of prompt caching — the serialized prefix must not shift
  // when a new turn is appended. oaiToAnthropicMessages must NOT inject anything
  // per-turn (cache_control is applied separately, afterward).
  const convo = [
    { role: "system", content: "you are terse" },
    { role: "user", content: [{ type: "text", text: "one" }] },
    { role: "assistant", content: "first reply" },
    { role: "user", content: [{ type: "text", text: "two" }] },
  ]
  const short = oaiToAnthropicMessages(convo.slice(0, 3)) // system + user + assistant
  const long = oaiToAnthropicMessages(convo) // + one more user turn

  assert.deepEqual(long.system, short.system)
  assert.deepEqual(long.messages.slice(0, short.messages.length), short.messages)
  // Byte-for-byte, not just structurally.
  assert.equal(
    JSON.stringify(long.messages.slice(0, short.messages.length)),
    JSON.stringify(short.messages),
  )
})

test("cache breakpoints: 1h on tools+system and rolling on last two messages, <=4 total", () => {
  const { system, messages } = oaiToAnthropicMessages([
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ])
  const tools = [{ name: "t", description: "", input_schema: {} }]
  applyCacheBreakpoints(system, messages, tools as never)

  const oneHour = { type: "ephemeral", ttl: "1h" }
  assert.deepEqual((tools[tools.length - 1] as AnyBlock).cache_control, oneHour)
  assert.deepEqual((system[system.length - 1] as AnyBlock).cache_control, oneHour)
  assert.deepEqual(lastBlock(messages[messages.length - 1]!).cache_control, oneHour)
  assert.deepEqual(lastBlock(messages[messages.length - 2]!).cache_control, oneHour)
  assert.ok(countBreakpoints(system as AnyBlock[], messages, tools as AnyBlock[]) <= 4)
})

test("cache breakpoints only annotate — stripping cache_control restores the original content", () => {
  const { system, messages } = oaiToAnthropicMessages([{ role: "user", content: "hi" }])
  const before = JSON.stringify(messages)
  applyCacheBreakpoints(system, messages, undefined)
  const after = JSON.parse(JSON.stringify(messages)) as Array<{ content: AnyBlock[] }>
  for (const m of after) for (const b of m.content) delete b.cache_control
  assert.equal(JSON.stringify(after), before)
})

test("umans/pi-ai: array-form user content survives translation to Context", () => {
  const ctx = oaiMessagesToContext([
    { role: "system", content: [{ type: "text", text: "sys" }] },
    { role: "user", content: [{ type: "text", text: "question" }] },
  ])
  assert.equal(ctx.systemPrompt, "sys")
  assert.equal(ctx.messages.length, 1)
  assert.deepEqual(ctx.messages[0]!.content, [{ type: "text", text: "question" }])
})
