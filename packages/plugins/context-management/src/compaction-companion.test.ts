import assert from "node:assert/strict"
import test from "node:test"
import type { Message } from "@nano/runtime-api/types"
import {
  NoopArchive,
  SnapcompactFramesArchive,
  TextAppendixArchive,
  resolveDeepArchiveBackend,
  initSnapcompactRenderer,
} from "./compaction-companion"
import type { Model } from "@nano/runtime-api/llm"
import type { RuntimeModelConfig } from "@nano/runtime-api/contracts/model"

const archiveModel: Model = {
  id: "archive-test",
  name: "Archive test",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://archive.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
}
const archiveConfig: RuntimeModelConfig = {
  primaryModel: archiveModel,
  primaryApiKey: undefined,
  primaryToolChoice: "auto",
  primaryVision: true,
  primaryNudgeOnNoTool: false,
  idleCompactionMs: 0,
  cacheWarming: false,
  cacheWarmingDurationMs: 0,
  cacheWarmingMode: "prewarm",
  cacheLifetimeMs: 0,
  enableThinking: false,
  thinkingEffort: "low",
  fallbackModel: archiveModel,
  fallbackApiKey: undefined,
  fallbackToolChoice: "auto",
  summaryModel: null,
  summaryApiKey: undefined,
  respectPromptCache: false,
  compactionStrategy: "companion",
  compactTriggerTokens: 1000,
  deepArchive: true,
  useFallback: false,
}
function userMsg(content: string): Message {
  return { role: "user", content, timestamp: Date.now() } as Message
}

test("text-appendix archive preserves discarded specifics as a reference block", async () => {
  const backend = new TextAppendixArchive()
  const discarded = [
    userMsg("the API key is sk-abc123 and the port is 4220"),
    userMsg("callie said the deadline is friday at https://example.com/spec"),
  ]
  const result = await backend.archive(discarded)
  assert.ok(result, "expected an archive result")
  assert.ok(result!.archiveMessage, "expected an appendix message")
  const body = String((result!.archiveMessage as { content: string }).content)
  assert.match(body, /deep archive/i)
  assert.match(body, /sk-abc123/)
  assert.match(body, /4220/)
  assert.match(body, /friday/)
  assert.match(body, /example\.com\/spec/)
})

test("text-appendix archive declines an empty span", async () => {
  const backend = new TextAppendixArchive()
  assert.equal(await backend.archive([]), null)
})

test("text-appendix archive elides overflow but keeps head and tail", async () => {
  const backend = new TextAppendixArchive()
  const big = "HEAD_MARKER " + "x".repeat(40_000) + " TAIL_MARKER"
  const result = await backend.archive([userMsg(big)])
  assert.ok(result)
  const body = String((result!.archiveMessage as { content: string }).content)
  assert.match(body, /HEAD_MARKER/)
  assert.match(body, /TAIL_MARKER/)
  assert.match(body, /chars elided/)
})

test("snapcompact-frames backend always declines an empty span", async () => {
  // Empty input declines regardless of renderer availability.
  const backend = new SnapcompactFramesArchive()
  assert.equal(await backend.archive([]), null)
})

test("snapcompact-frames renders a PNG image message when the native renderer is available", async () => {
  const backend = new SnapcompactFramesArchive()
  const result = await backend.archive([userMsg("the api key is sk-abc123 and the port is 4220")])
  if (!result) {
    // The @oh-my-pi/pi-natives native binary may be absent (e.g. a platform
    // without a prebuilt addon); in that case the backend fails closed to null
    // and the FirstAvailableArchive falls through to the text appendix.
    console.warn("[test] snapcompact renderer unavailable; skipping frame assertions")
    return
  }
  const msg = result.archiveMessage as { content: Array<{ type: string; mimeType?: string; data?: string }> }
  assert.ok(Array.isArray(msg.content), "expected array content with an image block")
  const img = msg.content.find((c) => c.type === "image")
  assert.ok(img, "expected an image block")
  assert.equal(img!.mimeType, "image/png")
  const buf = Buffer.from(img!.data ?? "", "base64")
  // PNG magic number.
  assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a")
})

test("initSnapcompactRenderer resolves when the native renderer is available (else throws)", async () => {
  // @oh-my-pi/pi-natives is a dependency, so in a normal test env the renderer
  // loads and init resolves without throwing. On a platform without a prebuilt
  // addon it would throw — which is the intended startup-crash behavior.
  try {
    await initSnapcompactRenderer()
  } catch (err) {
    assert.match(String((err as Error).message), /native renderer could not be loaded/)
    console.warn("[test] snapcompact renderer unavailable in this env; init threw as designed")
  }
})

test("first-available archive returns the first backend that produces a result", async () => {
  const { FirstAvailableArchive } = await import("./compaction-companion")
  // TextAppendixArchive always succeeds, so ordering it first guarantees a
  // deterministic result independent of native renderer availability.
  const backend = new FirstAvailableArchive([new TextAppendixArchive(), new SnapcompactFramesArchive()])
  const result = await backend.archive([userMsg("exact detail sk-xyz to preserve")])
  assert.ok(result, "expected a result from the first working backend")
  const body = String((result!.archiveMessage as { content: string }).content)
  assert.match(body, /deep archive/i)
})

test("noop archive always declines", async () => {
  const backend = new NoopArchive()
  assert.equal(await backend.archive(), null)
})

test("default deep-archive backends preserve source details", async () => {
  for (const provider of ["anthropic", "openai", undefined]) {
    const result = await resolveDeepArchiveBackend(provider, false, archiveConfig).archive([userMsg("provider-specific-marker")])
    assert.ok(result)
    const content = (result.archiveMessage as { content: unknown }).content
    if (typeof content === "string") assert.match(content, /provider-specific-marker/)
    else assert.ok(Array.isArray(content) && content.some((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "image"))
  }
})

test("forced snapcompact ignores the model's deep-archive toggle", async () => {
  const result = await resolveDeepArchiveBackend("anthropic", true, { ...archiveConfig, deepArchive: false }).archive([
    userMsg("forced-snapcompact-marker"),
  ])
  assert.ok(result)
  assert.match(result!.note, /snapcompact|text-appendix/)
})
