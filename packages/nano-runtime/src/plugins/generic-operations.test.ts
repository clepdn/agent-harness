import assert from "node:assert/strict"
import test from "node:test"
import { CordisContext, Contributions, listContributions, type Plugin } from "@nano/plugins"
import { AssistantMessageEventStream, type AssistantMessage, type CompletionContext, type Model, type OpenAICompletionsOptions } from "@nano/runtime-api/model"
import { conversationHistory, conversationSubmit, modelComplete, modelList, modelStream, toolsList, type ModelDescriptor, type ModelStreamEvent } from "@nano/protocol"
import { nano, type ConversationService, type ModelService, type ToolContribution, type ToolService } from "@nano/runtime-api"
import { conversationOperationsPlugin, modelOperationsPlugin, toolsListOperationsPlugin } from "@nano/plugin-generic-operations"

const model: Model = {
  id: "rpc-model", name: "RPC model", api: "rpc-test", provider: "rpc-provider", baseUrl: "https://rpc.invalid",
  reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 512,
}

const answer = (text: string): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1,
})

function servicePlugin(services: { conversation?: ConversationService; model?: ModelService; tools?: ToolService }): Plugin {
  return {
    name: "generic-operation-test-services",
    inject: ["nano.contributions"],
    apply(ctx) {
      if (services.conversation) ctx.provide(nano.conversation.name, services.conversation)
      if (services.model) ctx.provide(nano.model.name, services.model)
      if (services.tools) ctx.provide(nano.tools.name, services.tools)
    },
  }
}

function operation(ctx: CordisContext, name: string) {
  const entry = listContributions(ctx, nano.operations).find((candidate) => candidate.key === name)
  assert.ok(entry, `missing operation ${name}`)
  return entry.value
}

function stream(ctx: CordisContext, name: string) {
  const entry = listContributions(ctx, nano.streams).find((candidate) => candidate.key === name)
  assert.ok(entry, `missing stream ${name}`)
  return entry.value
}

const rpcContext = { signal: new AbortController().signal, subject: "test-client" }

async function rootContext() {
  const ctx = new CordisContext()
  await ctx.plugin(Contributions)
  return ctx
}

test("generic conversation operations use public service methods and serialize history", async () => {
  const submitted: string[] = []
  const conversation: ConversationService = {
    submit: ({ event }) => { submitted.push(event.content); return { accepted: true, running: false } },
    history: async () => [{ role: "user", content: "hello", timestamp: 1 }],
    subscribe: async function* () { yield { seq: 1, event: { type: "message", text: "hello" } } },
    cancel: () => {},
  }
  const ctx = await rootContext()
  await ctx.plugin(servicePlugin({ conversation }))
  await ctx.plugin(conversationOperationsPlugin)
  const submit = operation(ctx, "conversation.submit")
  const result = conversationSubmit.output.parse(await submit.handler({ event: { source: "chat", triggeredAt: "2026-01-01T00:00:00.000Z", content: "hello", raw: { arbitrary: [1, true] } } }, rpcContext))
  assert.deepEqual(result, { accepted: true, running: false })
  assert.deepEqual(submitted, ["hello"])
  const history = operation(ctx, conversationHistory.name)
  assert.deepEqual(conversationHistory.output.parse(await history.handler({}, rpcContext)), [{ role: "user", content: "hello", timestamp: 1 }])
  const events: unknown[] = []
  const source = await stream(ctx, "conversation.subscribe").handler({}, rpcContext) as AsyncIterable<unknown>
  for await (const item of source) events.push(item)
  assert.deepEqual(events, [{ seq: 1, event: { type: "message", text: "hello" } }])
  await ctx.fiber.dispose()
})

test("generic model operations decode context, preserve JSON tool arguments, and map stream events", async () => {
  let received: CompletionContext | undefined
  const modelService: ModelService = {
    list: () => [model], listPresets: () => [], resolver: () => () => [],
    current: () => ({ primaryModel: model, primaryApiKey: undefined, primaryToolChoice: "auto", primaryVision: false, primaryNudgeOnNoTool: false, idleCompactionMs: 0, cacheWarming: false, cacheWarmingDurationMs: 0, cacheWarmingMode: "completion", cacheLifetimeMs: 0, enableThinking: true, thinkingEffort: "low", fallbackModel: model, fallbackApiKey: undefined, fallbackToolChoice: "auto", summaryModel: null, summaryApiKey: undefined, respectPromptCache: false, compactionStrategy: "off", compactTriggerTokens: 0, deepArchive: false, useFallback: false }),
    resolveModelSwap: () => { throw new Error("not used") }, applyModelSwap: () => {}, persistModelSwap: async () => {}, persistedPreset: () => undefined,
    getFastMode: () => false, setFastMode: () => false, serviceTier: () => undefined,
    complete: async (_current, context) => { received = context; return answer("done") },
    stream: () => { const result = new AssistantMessageEventStream(); result.push({ type: "text_delta", contentIndex: 0, delta: "hi", partial: answer("") }); result.push({ type: "done", reason: "stop", message: answer("hi") }); result.end(); return result },
  }
  const ctx = await rootContext()
  await ctx.plugin(servicePlugin({ model: modelService }))
  await ctx.plugin(modelOperationsPlugin)
  const descriptor = modelList.output.parse(await operation(ctx, modelList.name).handler({}, rpcContext))[0]!
  const complete = operation(ctx, modelComplete.name)
  const output = modelComplete.output.parse(await complete.handler({ model: descriptor, context: { messages: [{ role: "user", content: "question", timestamp: 1 }], tools: [{ name: "lookup", description: "lookup", parameters: { type: "object", properties: { value: { type: "string" } } } }] }, options: { temperature: 0.2, toolChoice: "auto" } }, rpcContext))
  assert.equal(output.role, "assistant")
  assert.equal(output.content[0]?.type, "text")
  assert.deepEqual(received?.tools?.[0]?.parameters.properties, { value: { type: "string" } })
  const items: ModelStreamEvent[] = []
  const modelSource = await stream(ctx, modelStream.name).handler({ model: descriptor, context: { messages: [] } }, rpcContext) as AsyncIterable<ModelStreamEvent>
  for await (const item of modelSource) items.push(item)
  assert.deepEqual(items, [{ type: "text_delta", delta: "hi" }, { type: "done", message: answer("hi") }])
  await ctx.fiber.dispose()
})

test("generic model operation forwards cancellation to the public model service", async () => {
  let observedSignal: AbortSignal | undefined
  const modelService = { list: () => [model], complete: (_model: Model, _context: CompletionContext, options?: OpenAICompletionsOptions) => {
    observedSignal = options?.signal
    return new Promise<AssistantMessage>((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal?.reason ?? new Error("cancelled")), { once: true }))
  } } as unknown as ModelService
  const ctx = await rootContext()
  await ctx.plugin(servicePlugin({ model: modelService }))
  await ctx.plugin(modelOperationsPlugin)
  const descriptor = model as unknown as ModelDescriptor
  const controller = new AbortController()
  const pending = operation(ctx, modelComplete.name).handler({ model: descriptor, context: { messages: [] } }, { signal: controller.signal, subject: "test" })
  controller.abort(new Error("cancelled by client"))
  assert.ok(observedSignal?.aborted)
  await assert.rejects(async () => { await pending })
  await ctx.fiber.dispose()
})

test("tools list exposes normalized definitions but no tools execute operation", async () => {
  const contribution: ToolContribution = { definition: { type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object", properties: { q: { type: "string" } } } } }, execute: () => "not public" }
  const tools: ToolService = { list: () => [contribution], execute: async () => "not public" }
  const ctx = await rootContext()
  await ctx.plugin(servicePlugin({ tools }))
  await ctx.plugin(toolsListOperationsPlugin)
  const value = await operation(ctx, toolsList.name).handler({}, rpcContext)
  assert.deepEqual(value, [{ name: "lookup", description: "Lookup", inputSchema: { type: "object", properties: { q: { type: "string" } } } }])
  assert.equal(listContributions(ctx, nano.operations).some((entry) => entry.key === "tools.execute"), false)
  await ctx.fiber.dispose()
})
