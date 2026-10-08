import assert from "node:assert/strict"
import test from "node:test"
import { CordisContext, Contributions, listContributions, type Plugin } from "@nano/plugins"
import {
  AssistantMessageEventStream,
  Context,
  modelProviders,
  registerModelProvider,
  type Model,
  type ModelProvider,
  type Usage,
} from "@nano/runtime-api/model"

const model: Model = {
  id: "third-party-test", name: "Third-party test", api: "third-party", provider: "third-party", baseUrl: "https://provider.invalid",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
}
const usage: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }

function provider(label: string): ModelProvider {
  const answer = (current: Model) => ({ role: "assistant" as const, content: [{ type: "text" as const, text: label }], api: "third-party", provider: current.provider, model: current.id, usage, stopReason: "stop" as const, timestamp: Date.now() })
  return {
    id: label, supports: (current) => current.api === "third-party", complete: async (current) => answer(current),
    stream: (current) => { const events = new AssistantMessageEventStream(); events.push({ type: "done", reason: "stop", message: answer(current) }); events.end(); return events },
    captureCacheWarmRequest: () => ({ label }), warmCache: async () => usage,
  }
}

function plugin(id: string, value: ModelProvider): Plugin {
  return { name: id, inject: ["nano.contributions"], apply(ctx) { registerModelProvider(ctx, id, value) } }
}

test("public providers dispatch through Context lineage and lifecycle replacement", async () => {
  const root = new CordisContext()
  await root.plugin(Contributions)
  const firstFiber = await root.plugin(plugin("first", provider("first")))
  const resolver = () => listContributions(root, modelProviders)
  const context = new Context({ model, providerResolver: resolver })
  context.append({ role: "user", content: "hello", timestamp: 0 })
  const fork = context.fork()
  assert.equal(fork.parentId, context.id)
  assert.equal(fork.items.length, context.items.length)
  const first = await context.complete({ captureCacheWarmRequest: true })
  assert.equal(first.content[0]?.type, "text")
  const firstPart = first.content[0]
  if (!firstPart || firstPart.type !== "text") throw new Error("provider returned no text")
  assert.equal(firstPart.text, "first")
  assert.equal(context.items.at(-1)?.role, "assistant")

  await firstFiber.dispose()
  await assert.rejects(context.warmCache(), /no longer installed/)
  await root.plugin(plugin("replacement", provider("replacement")))
  const replacement = await context.fork({ reason: "fork" }).complete()
  const replacementPart = replacement.content[0]
  if (!replacementPart || replacementPart.type !== "text") throw new Error("replacement returned no text")
  assert.equal(replacementPart.text, "replacement")
  assert.deepEqual(listContributions(root, modelProviders).map(({ key }) => key), ["replacement"])
  await root.fiber.dispose()
})
