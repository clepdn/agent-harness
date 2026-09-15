import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import test, { after } from "node:test"
import type { Model, UserMessage, ToolResultMessage } from "./llm"
import type { LoopHooks, LoopState } from "./runner/types"

const home = await fs.mkdtemp("/tmp/nano-context-images-")
process.env.NANO_HOME = home
process.env.NANO_AGENT_STATE_DIR = `${home}/state`
after(() => fs.rm(home, { recursive: true, force: true }))
const { config } = await import("./config")
const { enabledContextImages, markdownImageReferences, prepareContextImages } = await import("./context-images")
const { complete, stream } = await import("./llm")
const { initDb, getDb, startConversation } = await import("./db")
initDb(":memory:")
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=", "base64")
await fs.mkdir(`${home}/memories/images`, { recursive: true })
await fs.mkdir(`${home}/memories/journal`, { recursive: true })
await fs.mkdir(`${home}/memories/skills`, { recursive: true })
await fs.writeFile(`${home}/memories/images/picture.png`, png)
const model: Model = {
  id: "test-vision", provider: "openai", name: "test", api: "openai-completions", baseUrl: "https://model.invalid/v1",
  reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8192,
}
const message = (content: string): UserMessage => ({ role: "user", content, timestamp: Date.now() })
const userId = "123456789012345678"

test("Markdown resolves local inline/reference images and excludes code, remote URLs, and traversal", () => {
  const doc = `${home}/memories/journal/today.md`
  const excerpt = '![photo](../images/picture.png)\n![spaced](<../images/a b.png>)\n![ref][portrait]\n![paren](../images/a(b).png)\n'
  const full = `${excerpt}\n[portrait]: ../images/other.png "title"\n`
  const refs = markdownImageReferences(excerpt, doc, full)
  assert.deepEqual(refs.map((ref) => ref.kind === "markdown" && path.basename(ref.path)), ["picture.png", "a b.png", "other.png", "a(b).png"])
  assert.equal(markdownImageReferences('`![code](a.png)`\n\n```md\n![code](b.png)\n```\n![net](https://example.com/p.png)\n![net](//example.com/a.png)\n![file](file:///etc/p.png)\n![escape](../../../../etc/p.png)', doc).length, 0)
  const uri = markdownImageReferences("![same](memory://images/picture.png)", `${home}/soul.md`)[0]
  assert.equal(uri?.kind === "markdown" && uri.path, `${home}/memories/images/picture.png`)
})

test("local images attach without rewriting text; missing, oversized, non-image and symlink targets fail softly", async (t) => {
  const oldMax = config.context_images.max_bytes
  t.after(() => { config.context_images.max_bytes = oldMax })
  t.mock.method(globalThis, "fetch", () => { throw new Error("local Markdown must not fetch the network") })
  await fs.writeFile(`${home}/memories/images/not-image.png`, "not an image")
  const outside = await fs.mkdtemp("/tmp/nano-outside-images-")
  t.after(() => fs.rm(outside, { recursive: true, force: true }))
  await fs.writeFile(`${outside}/outside.png`, png)
  await fs.symlink(`${outside}/outside.png`, `${home}/memories/images/escape.png`)
  const msg = message("original text")
  msg.imageReferences = markdownImageReferences("![ok](images/picture.png) ![missing](images/missing.png) ![bad](images/not-image.png) ![escape](images/escape.png)", `${home}/memories/core.md`)
  await prepareContextImages([msg])
  assert.equal(msg.content, "original text")
  assert.equal(msg.imageAttachments?.length, 1)
  assert.equal(msg.imageAttachments?.[0].mimeType, "image/png")
  assert.equal(msg.imageNotes?.length, 3)
  await prepareContextImages([msg])
  assert.equal(msg.imageAttachments?.length, 1)
  config.context_images.max_bytes = png.length - 1
  const oversized = { ...message("oversized"), imageReferences: msg.imageReferences!.slice(0, 1) }
  await prepareContextImages([oversized])
  assert.equal(oversized.imageAttachments, undefined)
  assert.equal(oversized.imageNotes?.length, 1)
})

test("avatars attach once per author in retained context across direct messages, batches and backread", async (t) => {
  const { discordEventImageReferences, discordToolImageReferences } = await import("./discord/context-avatars")
  const { ingestDiscordEvent } = await import("./discord/state")
  const old = config.discord.include_user_avatars
  t.after(() => { config.discord.include_user_avatars = old })
  config.discord.include_user_avatars = true
  const payload = { id: "223456789012345678", channel_id: "323456789012345678", content: "hello", author: { id: userId, username: "alice", avatar: "avatar_hash" } }
  getDb().prepare("insert into discord_user_pronouns (user_id, pronouns, updated_at) values (?, ?, ?)").run(userId, "", new Date().toISOString())
  ingestDiscordEvent(payload)
  const direct = { ...message("hello from alice"), imageReferences: discordEventImageReferences({ source: "discord", content: "hello", triggeredAt: new Date().toISOString(), raw: payload }) }
  const backread = { ...message("stored alice message"), imageReferences: discordToolImageReferences(JSON.stringify([{ message_id: payload.id }])) }
  const batch = discordEventImageReferences({ source: "discord", content: `- source_item_id=${payload.id}: hello`, triggeredAt: new Date().toISOString(), raw: null })
  assert.equal(batch[0]?.kind === "discord-avatar" && batch[0].userId, userId)
  let downloads = 0
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    assert.match(String(url), /^https:\/\/cdn.discordapp.com\/avatars\//)
    downloads++
    return new Response(png, { headers: { "content-type": "image/png" } })
  })
  await prepareContextImages([direct, backread])
  await prepareContextImages([direct, backread])
  assert.equal(downloads, 1)
  assert.equal(direct.imageAttachments?.length, 1)
  assert.equal(backread.imageAttachments, undefined)
  // If compaction removes the pictured message, the next surviving occurrence gets the image.
  await prepareContextImages([backread])
  assert.equal(downloads, 2)
  config.discord.include_user_avatars = false
  assert.equal(enabledContextImages(direct).length, 0)
  assert.deepEqual(discordEventImageReferences({ source: "discord", content: "hello", triggeredAt: "", raw: payload }), [])
})

test("custom Discord emoji attach as PNG bitmaps and animated emoji use one frame", async (t) => {
  const { discordEventImageReferences, discordToolImageReferences } = await import("./discord/context-avatars")
  const old = config.discord.attach_emoji_bitmap
  assert.equal(old, true)
  t.after(() => { config.discord.attach_emoji_bitmap = old })
  config.discord.attach_emoji_bitmap = true

  const staticId = "523456789012345678"
  const animatedId = "623456789012345678"
  const content = `hello <:wave:${staticId}> <a:dance:${animatedId}> <:wave:${staticId}>`
  const event = { source: "discord" as const, content, triggeredAt: new Date().toISOString(), raw: { content } }
  const refs = discordEventImageReferences(event)
  assert.deepEqual(refs.map((ref) => ref.kind), ["discord-emoji", "discord-emoji"])
  assert.deepEqual(refs.map((ref) => ref.kind === "discord-emoji" && [ref.emojiId, ref.animated]), [
    [staticId, false],
    [animatedId, true],
  ])
  assert.equal(discordToolImageReferences(JSON.stringify([{ content }])).length, 2)

  const requested: string[] = []
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    const parsed = new URL(String(url))
    requested.push(parsed.toString())
    assert.match(parsed.pathname, new RegExp(`/emojis/(${staticId}|${animatedId})\\.png$`))
    assert.equal(parsed.searchParams.get("size"), "128")
    return new Response(png, { headers: { "content-type": "image/png" } })
  })

  const direct = { ...message(content), imageReferences: refs }
  const repeated = { ...message(content), imageReferences: discordToolImageReferences(JSON.stringify([{ content }])) }
  await prepareContextImages([direct, repeated])
  assert.equal(requested.length, 2)
  assert.deepEqual(direct.imageAttachments?.map((image) => image.mimeType), ["image/png", "image/png"])
  assert.equal(repeated.imageAttachments, undefined)

  config.discord.attach_emoji_bitmap = false
  assert.deepEqual(discordEventImageReferences(event), [])
  assert.equal(enabledContextImages(direct).length, 0)
})

test("prompt estimates budget images without tokenizing their base64 bytes", async () => {
  const { estimatePromptTokens } = await import("./runner/messages")
  const msg = message("picture")
  msg.imageReferences = markdownImageReferences("![picture](images/picture.png)", `${home}/memories/core.md`)
  await prepareContextImages([msg])
  const estimate = estimatePromptTokens([msg])
  msg.imageAttachments![0].data = "A".repeat(1_000_000)
  assert.equal(estimatePromptTokens([msg]), estimate)
  assert.ok(estimate >= estimatePromptTokens([message("picture")]) + 1024)
})

test("model requests contain image bytes with correct tool ordering and honor vision opt-out", async (t) => {
  const oldMarkdown = config.context_images.markdown
  t.after(() => { config.context_images.markdown = oldMarkdown })
  const bodies: any[] = []
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    bodies.push(body)
    return body.stream
      ? new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
      : Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })
  })
  const refs = markdownImageReferences("![picture](images/picture.png)", `${home}/memories/core.md`)
  const tool = (id: string): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: "read_file", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 0, imageReferences: refs })
  const context = { messages: [tool("one"), tool("two")] }
  await complete(model, context, { apiKey: "test" })
  assert.deepEqual(bodies[0].messages.map((msg: any) => msg.role), ["tool", "tool", "user"])
  assert.match(bodies[0].messages[2].content[1].image_url.url, /^data:image\/png;base64,/)
  const output = await stream(model, context, { apiKey: "test" }).result()
  assert.equal(output.stopReason, "stop")
  assert.equal(bodies[1].messages[2].content[1].image_url.url, bodies[0].messages[2].content[1].image_url.url)
  await complete(model, context, { apiKey: "test", includeContextImages: false })
  assert.deepEqual(bodies[2].messages.map((msg: any) => msg.role), ["tool", "tool"])
  await complete({ ...model, input: ["text"] }, context, { apiKey: "test" })
  assert.deepEqual(bodies[3].messages.map((msg: any) => msg.role), ["tool", "tool"])
  config.context_images.markdown = false
  await complete(model, context, { apiKey: "test" })
  assert.deepEqual(bodies[4].messages.map((msg: any) => msg.role), ["tool", "tool"])
  config.context_images.markdown = true
  const { scrubImagesFromConversation } = await import("./runner/messages")
  assert.equal(scrubImagesFromConversation(context.messages), 2)
  await complete(model, context, { apiKey: "test" })
  assert.deepEqual(bodies[5].messages.map((msg: any) => msg.role), ["tool", "tool"])
})

test("bootstrap attaches soul/core images and the bot avatar on each fresh context, preserved across resume", async (t) => {
  const { buildBootstrap } = await import("./bootstrap")
  const { loadSession, saveSession } = await import("./runner/session")
  const oldToken = config.discord.bot_token
  const oldAvatar = config.discord.include_bot_avatar
  t.after(() => { config.discord.bot_token = oldToken; config.discord.include_bot_avatar = oldAvatar })
  config.discord.bot_token = "test-token"
  config.discord.include_bot_avatar = true
  await fs.writeFile(`${home}/soul.md`, "I am a test agent.\n![self](memories/images/picture.png)\n")
  await fs.writeFile(`${home}/memories/core.md`, "# Core\n![photo](images/picture.png)\n")
  let downloads = 0
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).startsWith("https://discord.com/api/")) {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bot test-token")
      return Response.json({ id: "423456789012345678", avatar: null, discriminator: "0" })
    }
    assert.match(String(url), /^https:\/\/cdn.discordapp.com\/embed\/avatars\/\d.png$/)
    assert.equal(new Headers(init?.headers).get("Authorization"), null)
    downloads++
    return new Response(png)
  })
  const event = { source: "chat" as const, content: "hello", triggeredAt: new Date().toISOString(), raw: null }
  const first = await buildBootstrap(event)
  await prepareContextImages(first)
  assert.equal(downloads, 1)
  assert.equal(first[0].role !== "assistant" && first[0].imageAttachments?.length, 2)
  assert.match(String(first[0].content), /You can include local images/)
  assert.doesNotMatch(await fs.readFile(`${home}/soul.md`, "utf8"), /You can include local images/)
  await saveSession({ version: 1, messages: first, toolCatalog: [], toolCatalogEpoch: 1, toolCatalogFingerprint: createHash("sha256").update("[]").digest("hex") })
  const restored = await loadSession()
  assert.ok(restored)
  await prepareContextImages(restored.messages)
  assert.equal(downloads, 1)
  const second = await buildBootstrap(event)
  await prepareContextImages(second)
  assert.equal(downloads, 2)
})

test("memory reads, skills, and search excerpts add references through the real tool path", async () => {
  const { buildToolHandlers } = await import("./runner/loop-tool-registry")
  const { executeToolCall } = await import("./runner/loop-tool-runtime")
  const { createNiriToolCatalog } = await import("./runner/tool-catalog")
  const { toolContextImageReferences } = await import("./tool-context-images")
  await fs.writeFile(`${home}/memories/journal/today.md`, "# Today\n![photo](../images/picture.png)\n")
  await fs.writeFile(`${home}/memories/skills/illustrated.md`, "---\ndescription: test\n---\n# Guide\n![guide][photo]\n\n[photo]: ../images/picture.png\n")
  const state = {
    conversation: [],
    pendingInputs: [],
    toolInFlight: false,
    toolCatalog: createNiriToolCatalog({ memory: true }),
  } as unknown as LoopState
  const hooks = { flushDeferredEvents() {} } as LoopHooks
  const convId = startConversation("test", new Date().toISOString())
  for (const [name, args] of [["read_file", { path: "memory://journal/today.md" }], ["skill", { name: "illustrated" }]] as const) {
    await executeToolCall(convId, state, hooks, buildToolHandlers(), { type: "toolCall", id: name, name, arguments: args })
    const msg = state.conversation.at(-1)!
    assert.equal(msg.role, "toolResult")
    assert.equal(msg.imageReferences?.length, 1)
  }
  await prepareContextImages(state.conversation)
  assert.ok(state.conversation.every((msg) => msg.role !== "assistant" && msg.imageAttachments?.length === 1))
  const refs = await toolContextImageReferences("memory_search", {}, JSON.stringify([{ uri: "memory://journal/today.md", content: "![photo](../images/picture.png)" }]))
  assert.equal(refs[0]?.kind === "markdown" && refs[0].path, `${home}/memories/images/picture.png`)
})
