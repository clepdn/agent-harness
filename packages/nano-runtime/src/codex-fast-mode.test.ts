import assert from "node:assert/strict"
import test from "node:test"
import { complete, stream, type Model } from "./llm"
import { codexServiceTier } from "./codex-fast-mode"
import { executionServices, providerResolver } from "./test-model-provider"

test("fast mode reaches streaming and non-streaming requests and excludes other models", async (t) => {
  const previous = executionServices.model.getFastMode()
  t.after(() => executionServices.model.setFastMode(previous))
  const bodies: any[] = []
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    bodies.push(body)
    const choice = { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }
    return body.stream
      ? new Response(`data: ${JSON.stringify({ choices: [{ ...choice, delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
      : Response.json({ choices: [choice] })
  })
  const model: Model = {
    id: "gpt-5.6-sol", provider: "openai", name: "test", api: "openai-completions",
    baseUrl: "https://bridge.invalid/v1", reasoning: true, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8192,
  }
  const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] }
  for (const enabled of [false, true, false]) {
    executionServices.model.setFastMode(enabled)
    for (const streaming of [false, true]) {
      const result = streaming
        ? await stream(model, context, { apiKey: "test", providerResolver }).result()
        : await complete(model, context, { apiKey: "test", providerResolver })
      assert.equal(result.stopReason, "stop")
      assert.equal(bodies.at(-1).service_tier, enabled ? "priority" : "default")
    }
  }
  executionServices.model.setFastMode(true)
  for (const id of ["claude-sonnet-4", "gemini-pro", "openai/gpt-5", "local-model"]) {
    await complete({ ...model, id }, context, { apiKey: "test", providerResolver })
    assert.equal(Object.hasOwn(bodies.at(-1), "service_tier"), false)
  }
  for (const id of ["Codex", "codex-mini-latest", "o3-mini", "o4-mini"]) {
    assert.equal(codexServiceTier({ ...model, id }, true), "priority")
  }
  assert.equal(codexServiceTier({ id: "custom", provider: "openai-codex" }, true), "priority")
})
