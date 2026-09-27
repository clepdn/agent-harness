import assert from "node:assert/strict"
import test from "node:test"
import { Context, type Model } from "./llm"

const model: Model = {
  id: "context-test",
  name: "context-test",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://context.invalid/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 1_000,
}

const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 })

function streamResponse(text = "ok"): Response {
  const chunk = { choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] }
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

function completionResponse(text = "ok"): Response {
  return Response.json({
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  })
}

test("append preserves lineage while item.context creates a truncated fork", () => {
  const context = new Context({ model, items: [user("one")] })
  const id = context.id
  context.append(user("two"))

  assert.equal(context.id, id)
  assert.deepEqual(context.items.map((item) => item.content), ["one", "two"])
  assert.equal(Object.isFrozen(context.items), true)
  assert.equal(Object.isFrozen(context.items[0]), true)

  const fork = context.items[0]!.context
  assert.notEqual(fork, context)
  assert.notEqual(fork.id, context.id)
  assert.equal(fork.parentId, context.id)
  assert.equal(fork.forkReason, "truncate")
  assert.deepEqual(fork.items.map((item) => item.content), ["one"])
})

test("rewrites and configuration changes produce new Context objects", () => {
  const context = new Context({ model, items: [user("original"), user("discarded tail")] })
  const edited = context.edit(0, user("edited"))
  const changedModel = edited.fork({ model: { ...model, id: "other" }, reason: "model-change" })

  assert.deepEqual(context.items.map((item) => item.content), ["original", "discarded tail"])
  assert.deepEqual(edited.items.map((item) => item.content), ["edited"])
  assert.equal(edited.parentId, context.id)
  assert.equal(changedModel.parentId, edited.id)
  assert.equal(changedModel.model?.id, "other")

  const restored = Context.restore({
    id: changedModel.id,
    parentId: changedModel.parentId,
    forkReason: changedModel.forkReason,
    model: changedModel.model,
    items: changedModel.items,
  })
  assert.equal(restored.id, changedModel.id)
  assert.equal(restored.parentId, edited.id)
  assert.equal(restored.forkReason, "model-change")
})

test("complete owns request settings and atomically appends the assistant", async (t) => {
  let body: Record<string, unknown> | undefined
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body))
    return streamResponse("hello")
  })
  const context = new Context({
    model,
    apiKey: "test",
    thinkingLevel: "high",
    toolChoice: "none",
    systemPrompt: "be useful",
    items: [user("hi")],
  })

  const response = await context.complete({ onEvent: () => {} })

  assert.equal(response.role, "assistant")
  assert.equal(context.items.at(-1)?.role, "assistant")
  assert.deepEqual((body?.messages as Array<{ role: string }>).map((item) => item.role), ["developer", "user"])
  assert.equal(body?.reasoning_effort, "high")
  assert.equal(body?.tool_choice, "none")
})

test("complete refuses to append a stale response when the Context changes in flight", async (t) => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  t.mock.method(globalThis, "fetch", async () => {
    await blocked
    return completionResponse()
  })
  const context = new Context({ model, apiKey: "test", items: [user("first")] })

  const pending = context.complete()
  context.append(user("new input"))
  release()

  await assert.rejects(pending, /changed while completion was in flight/)
  assert.deepEqual(context.items.map((item) => item.role), ["user", "user"])
})

test("cache warming replays the exact successful wire prompt and never appends output", async (t) => {
  const bodies: any[] = []
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    return completionResponse("discard me")
  })
  const context = new Context({ model: { ...model, id: "gpt-6-sol" }, apiKey: "test", systemPrompt: "stable instructions",
    thinkingLevel: "high", toolChoice: "auto", tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }], items: [user("hello")] })
  assert.equal(await context.warmCache(), undefined, "an unseeded context makes no request")
  await context.complete({ captureCacheWarmRequest: true })
  const lastCompletionAt = context.lastCompletionAt
  context.append(user("new input that must not enter the warming replay"))
  const before = context.snapshot()
  await context.warmCache()
  assert.deepEqual(bodies[1], { ...bodies[0], max_completion_tokens: 1 })
  await context.warmCache({ mode: "prewarm" })
  assert.deepEqual(bodies[2], { ...bodies[0], prompt_cache_options: { prewarm: true, ttl: "30m" } })
  assert.deepEqual(context.snapshot(), before)
  assert.equal(context.lastCompletionAt, lastCompletionAt, "warming must not move the real-request clock")
  assert.equal(bodies.length, 3)
  assert.equal(context.fork().lastCacheUseAt, undefined, "forks cannot warm the old request")
})

test("streaming requests retain their prompt for warming, and prewarm errors never generate a fallback", async (t) => {
  const bodies: any[] = []
  let reject = false
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    bodies.push(body)
    if (reject) return Response.json({ error: { message: "unsupported prewarm" } }, { status: 400 })
    return body.stream ? streamResponse() : completionResponse()
  })
  const context = new Context({ model, apiKey: "test", items: [user("hello")] })
  await context.complete({ captureCacheWarmRequest: true, onEvent: () => {} })
  const before = context.snapshot()
  const lastUsed = context.lastCacheUseAt
  reject = true
  await assert.rejects(context.warmCache({ mode: "prewarm" }), /unsupported prewarm/)
  assert.deepEqual(bodies[1].messages, bodies[0].messages)
  assert.equal(bodies[1].stream, false)
  assert.equal(bodies[1].stream_options, undefined)
  assert.equal(bodies.length, 2, "rejected prewarming must not retry as normal generation")
  assert.equal(context.lastCacheUseAt, lastUsed)
  assert.deepEqual(context.snapshot(), before)
})
