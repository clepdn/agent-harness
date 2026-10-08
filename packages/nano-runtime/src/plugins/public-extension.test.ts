import assert from "node:assert/strict"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import type { AddressInfo } from "node:net"
import { CordisContext, Contributions, defineEvent, defineService, emitEvent, getService, listContributions, onEvent } from "@nano/plugins"
import type { Plugin } from "@nano/plugins"
import { defineOperation, defineValidator } from "@nano/protocol"
import { registerOperation } from "@nano/protocol/rpc"
import { AssistantMessageEventStream, Context, ContextChangedError, registerModelProvider } from "@nano/runtime-api/model"
import type { ClientToolResult } from "@nano/harness-protocol"
import type { AssistantMessage, CompletionContext, Model, ModelProvider, ModelProviderResolver, OpenAICompletionsOptions, Usage } from "@nano/runtime-api/model"
import { modelProviderResolver, nano, registerCommand, registerTool } from "@nano/runtime-api"
import { clientPlugin } from "@nano/plugin-client"
import { toolFamiliesPlugin } from "@nano/plugin-tool-families"
import { toolsPlugin } from "@nano/plugin-tools"
import type { ClientService, ImageService, ToolContribution, ToolContributionContext } from "@nano/runtime-api"
import { AGENT_ID } from "@nano/runtime-api/agent-config"

const model: Model = {
  id: "community-model",
  name: "Community model",
  api: "community-test",
  provider: "community-test",
  baseUrl: "https://community.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
}

const usage: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const providerKey = "com.example.community-provider"

function answer(current: Model, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: current.api,
    provider: current.provider,
    model: current.id,
    usage,
    stopReason: "stop",
    timestamp: 0,
  }
}

function fakeProvider(label: string, complete?: ModelProvider["complete"]): ModelProvider {
  return {
    id: `community-${label}`,
    supports: (current) => current.api === model.api,
    complete: complete ?? (async (current, request) => {
      assert.ok(request.messages.some((message) => message.role === "user"))
      return answer(current, label)
    }),
    stream(current, request) {
      assert.ok(request.messages.length > 0)
      const events = new AssistantMessageEventStream()
      events.push({ type: "done", reason: "stop", message: answer(current, label) })
      events.end()
      return events
    },
  }
}

function providerPlugin(provider: ModelProvider): Plugin {
  return {
    name: "com.example.community-provider-plugin",
    inject: ["nano.contributions"],
    apply(ctx) { return registerModelProvider(ctx, providerKey, provider) },
  }
}
function textOf(message: AssistantMessage): string {
  const part = message.content[0]
  assert.ok(part && part.type === "text")
  return part.text
}

async function createHost() {
  const ctx = new CordisContext()
  await ctx.plugin(Contributions)
  return ctx
}

test("public provider registration serves Context completion and streaming through replacement", async () => {
  const ctx = await createHost()
  let resolveProviders: ModelProviderResolver | undefined
  await ctx.plugin({ name: "com.example.provider-resolver", inject: ["nano.contributions"], apply(ctx) { resolveProviders = modelProviderResolver(ctx) } })
  const first = fakeProvider("first", async (current, request) => {
    assert.deepEqual(request.messages, [{ role: "user", content: "original prompt", timestamp: 1 }])
    return answer(current, "first")
  })
  let providerFiber = await ctx.plugin(providerPlugin(first))

  const context = new Context({ model, providerResolver: resolveProviders })
  const prior = { role: "user" as const, content: "original prompt", timestamp: 1 }
  context.append(prior)
  const originalItems = context.snapshot()
  assert.ok(Object.isFrozen(context.items))
  assert.ok(Object.isFrozen(context.items[0]))
  assert.ok(Object.isFrozen(context.items[0]?.content))

  const completed = await context.complete()
  assert.equal(textOf(completed), "first")
  assert.deepEqual(context.snapshot().slice(0, 1), originalItems)
  assert.equal(context.items.at(-1)?.role, "assistant")

  const streamContext = context.fork()
  const receivedEvents: string[] = []
  const streamed = await streamContext.complete({
    onEvent(event) {
      receivedEvents.push(event.type)
    },
  })
  const mutatingProvider = fakeProvider("mutation", async (current, request) => {
    const userMessage = request.messages.find((message) => message.role === "user")
    assert.ok(userMessage && userMessage.role === "user")
    userMessage.content = "provider-owned mutation"
    return answer(current, "isolated")
  })
  const beforeMutation = context.snapshot()
  await providerFiber.dispose()
  providerFiber = await ctx.plugin(providerPlugin(mutatingProvider))
  const isolated = await context.fork().complete()
  assert.equal(textOf(isolated), "isolated")
  assert.deepEqual(context.snapshot(), beforeMutation)
  await providerFiber.dispose()
  providerFiber = await ctx.plugin(providerPlugin(fakeProvider("first")))
  assert.equal(textOf(streamed), "first")
  assert.ok(receivedEvents.includes("done"))
  assert.deepEqual(streamContext.snapshot().slice(0, 2), context.snapshot())

  await providerFiber.dispose()
  providerFiber = await ctx.plugin(providerPlugin(fakeProvider("replacement")))
  const afterReplacement = await context.fork().complete()
  assert.equal(textOf(afterReplacement), "replacement")
  assert.deepEqual(listContributions(ctx, nano.modelProviders).map(({ key }) => key), [providerKey])
  await ctx.fiber.dispose()
})

test("provider completion commits atomically and rejects stale context revisions", async () => {
  let started!: () => void
  let release!: () => void
  const providerStarted = new Promise<void>((resolve) => { started = resolve })
  const providerRelease = new Promise<void>((resolve) => { release = resolve })
  const provider = fakeProvider("atomic", async (current) => {
    started()
    await providerRelease
    return answer(current, "stale response")
  })
  const ctx = await createHost()
  let resolveProviders: ModelProviderResolver | undefined
  await ctx.plugin({ name: "com.example.atomic-resolver", inject: ["nano.contributions"], apply(ctx) { resolveProviders = modelProviderResolver(ctx) } })
  await ctx.plugin(providerPlugin(provider))
  assert.ok(resolveProviders)
  const context = new Context({ model, providerResolver: resolveProviders })
  context.append({ role: "user", content: "before request", timestamp: 2 })
  const beforeRequest = context.snapshot()
  const pending = context.complete()
  await providerStarted
  context.append({ role: "user", content: "arrived while completing", timestamp: 3 })
  release()
  await assert.rejects(pending, ContextChangedError)
  assert.deepEqual(context.snapshot(), [...beforeRequest, { role: "user", content: "arrived while completing", timestamp: 3 }])
  assert.equal(context.items.some((item) => item.role === "assistant"), false)
  await ctx.fiber.dispose()
})

test("provider registration aborts in-flight completion before Context can append", async () => {
  let started!: () => void
  const providerStarted = new Promise<void>((resolve) => { started = resolve })
  const provider = fakeProvider("abort", async (_current, _request: CompletionContext, options?: OpenAICompletionsOptions) => {
    started()
    const signal = options?.signal
    assert.ok(signal, "registered provider receives its owner cancellation signal")
    if (signal.aborted) throw new Error("provider request aborted")
    await new Promise<never>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("provider request aborted")), { once: true }) })
    throw new Error("unreachable")
  })
  const ctx = await createHost()
  let resolveProviders: ModelProviderResolver | undefined
  await ctx.plugin({ name: "com.example.abort-resolver", inject: ["nano.contributions"], apply(ctx) { resolveProviders = modelProviderResolver(ctx) } })
  const providerFiber = await ctx.plugin(providerPlugin(provider))
  assert.ok(resolveProviders)
  const context = new Context({ model, providerResolver: resolveProviders })
  context.append({ role: "user", content: "cancel this request", timestamp: 4 })
  const pending = context.complete()
  await providerStarted
  await providerFiber.dispose()
  await assert.rejects(pending, /aborted/)
  assert.equal(context.items.length, 1)
  assert.equal(context.items[0]?.role, "user")
  await ctx.fiber.dispose()
})


test("provider registration cancels in-flight streams and commits no partial assistant", async () => {
  let started!: () => void
  const providerStarted = new Promise<void>((resolve) => { started = resolve })
  const provider: ModelProvider = {
    ...fakeProvider("stream-abort"),
    stream(_current, _request, options) {
      const events = new AssistantMessageEventStream()
      const signal = options?.signal
      assert.ok(signal, "registered provider receives its owner cancellation signal")
      started()
      signal.addEventListener("abort", () => events.fail(new Error("provider stream aborted")), { once: true })
      return events
    },
  }
  const ctx = await createHost()
  let resolveProviders: ModelProviderResolver | undefined
  await ctx.plugin({ name: "com.example.stream-abort-resolver", inject: ["nano.contributions"], apply(ctx) { resolveProviders = modelProviderResolver(ctx) } })
  const providerFiber = await ctx.plugin(providerPlugin(provider))
  assert.ok(resolveProviders)
  const context = new Context({ model, providerResolver: resolveProviders })
  context.append({ role: "user", content: "cancel this stream", timestamp: 5 })
  const receivedEvents: string[] = []
  const pending = context.complete({ onEvent: (event) => { receivedEvents.push(event.type) } })
  await providerStarted

  await providerFiber.dispose()
  await assert.rejects(pending, /abort/i)
  assert.ok(receivedEvents.includes("error"))
  assert.equal(context.items.length, 1)
  assert.equal(context.items[0]?.role, "user")
  await ctx.fiber.dispose()
})

function toolHooks(): ToolContributionContext["hooks"] {
  return {
    waitForEvent: async () => null,
    waitForEventWithTimeout: async (_timeoutMs: number) => null,
    injectIncomingEvent(_convId: number, _event: ToolContributionContext["state"]["pendingInputs"][number]) {},
    flushDeferredEvents() {},
    refreshToolCatalog(_reason: "post-compaction") {},
    clearSession: async () => {},
    saveSession: async () => {},
    saveShutdownSnapshot: async () => {},
    shouldShutdown: () => false,
    resolveShutdown() {},
  }
}

function toolState(runtimeKind: "main" | "frontend"): ToolContributionContext["state"] {
  return {
    runtimeKind,
    context: new Context({ model }),
    pendingInputs: [],
    tokenCount: 0,
    contextSize: 0,
    toolCatalog: [],
    toolCatalogEpoch: 0,
    toolCatalogFingerprint: "",
    toolInFlight: false,
    memoryRecallCooldowns: {},
    memoryRecallTurn: 0,
    memoryRecallPending: false,
    shutdownRequested: false,
    turnInFlight: false,
    restRequested: false,
    restReason: "",
  } satisfies ToolContributionContext["state"]
}

function toolContext(state: ToolContributionContext["state"], name: string, args: Record<string, unknown>): ToolContributionContext {
  return {
    signal: new AbortController().signal,
    convId: 7,
    state,
    hooks: toolHooks(),
    call: { type: "toolCall", id: `call-${name}`, name, arguments: args },
    args,
  }
}

function visionModelPlugin(): Plugin {
  return { name: "com.example.vision-model", apply(ctx) { ctx.provide(nano.model.name, { current: () => ({ primaryVision: true }) } as never) } }
}

function fakeImagesPlugin(calls: string[]): Plugin {
  return {
    name: "com.example.images",
    apply(ctx) {
      const images = {
        prepareMessages: (messages: unknown) => messages,
        fetchRemoteImage: async (url: string) => { calls.push(url); return { path: url, mime: "image/png", bytes: 3, dataUrl: "data:image/png;base64,AQID" } },
        memoryExcerptImageReferences: async () => [],
      } as unknown as ImageService
      ctx.provide(nano.images.name, images)
    },
  }
}
function fakeClientPlugin(calls: string[]): Plugin {
  return {
    name: "com.example.client",
    apply(ctx) {
      ctx.provide(nano.client.name, {
        capabilities: () => ["image_tool"],
        workspace: () => ({ id: "test", root: process.cwd(), imageRoot: process.cwd() }),
        execute: async (input: { tool: string }): Promise<ClientToolResult> => { calls.push(input.tool); return { type: "tool.result", invocationId: "fake", agentId: "test", status: "ok", output: "unexpected executor use", completedAt: new Date().toISOString() } },
      } as unknown as ClientService)
    },
  }
}

test("frontend image_tool rejects local paths without invoking the client and keeps URL behavior", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-frontend-image-tool-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const localImage = path.join(root, "private.png")
  await fs.writeFile(localImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const executorCalls: string[] = []
  const remoteCalls: string[] = []
  const ctx = await createHost()
  await ctx.plugin(visionModelPlugin())
  await ctx.plugin(fakeClientPlugin(executorCalls))
  await ctx.plugin(fakeImagesPlugin(remoteCalls))
  await ctx.plugin(toolsPlugin)
  await ctx.plugin(toolFamiliesPlugin)
  try {
    const service = getService(ctx, nano.tools)
    const image = service.list("frontend").find(({ definition }) => definition.function.name === "image_tool")
    assert.ok(image)
    const state = toolState("frontend")
    state.toolCatalog = service.list("frontend").map(({ definition }) => definition)
    const context = toolContext(state, "image_tool", { path: localImage })
    await assert.rejects(service.execute("image_tool", { path: localImage }, context), /accepts only HTTP\(S\) URLs/)
    assert.deepEqual(executorCalls, [])
    assert.deepEqual(remoteCalls, [])

    const url = "https://images.example.test/public.png"
    await service.execute("image_tool", { path: url, note: "inspect" }, toolContext(state, "image_tool", { path: url, note: "inspect" }))
    const toolResult = state.context.items.find((message) => message.role === "toolResult")
    assert.ok(toolResult?.role === "toolResult" && !toolResult.isError)
    assert.deepEqual(remoteCalls, [url])
    assert.deepEqual(executorCalls, [])
    const imageMessage = state.context.items.find((message) => message.role === "user" && Array.isArray(message.content) && message.content.some((part) => part.type === "image"))
    assert.ok(imageMessage, "public URL image reaches the frontend conversation")
  } finally {
    await ctx.fiber.dispose()
  }
})
test("builtin client image_tool carries a consumer deadline beyond 30 seconds to a delayed executor", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  let invocation: { invocationId: string; agentId: string; issuedAt: string; deadlineAt: string } | undefined
  const executor = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ capabilities: ["image_tool"], workspace: { id: "loopback", root: process.cwd() } }))
      return
    }
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    req.on("end", () => {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      if (!parsed || typeof parsed !== "object" || !("invocationId" in parsed) || !("agentId" in parsed) || !("issuedAt" in parsed) || !("deadlineAt" in parsed)) {
        res.writeHead(400).end()
        return
      }
      if (typeof parsed.invocationId !== "string" || typeof parsed.agentId !== "string" || typeof parsed.issuedAt !== "string" || typeof parsed.deadlineAt !== "string") {
        res.writeHead(400).end()
        return
      }
      invocation = { invocationId: parsed.invocationId, agentId: parsed.agentId, issuedAt: parsed.issuedAt, deadlineAt: parsed.deadlineAt }
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({
          type: "tool.result",
          invocationId: invocation?.invocationId,
          agentId: invocation?.agentId,
          status: "ok",
          image: { path: "/client/images/delayed.png", mime: "image/png", bytes: 3, dataUrl: "data:image/png;base64,AQID" },
          completedAt: new Date().toISOString(),
        }))
      }, 30_001)
    })
  })
  await new Promise<void>((resolve) => executor.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve) => executor.close(() => resolve())))
  const endpoint = `http://127.0.0.1:${(executor.address() as AddressInfo).port}`
  const ctx = await createHost()
  await ctx.plugin(visionModelPlugin())
  await ctx.plugin(clientPlugin({ endpoint, agentId: AGENT_ID }))
  await ctx.plugin(toolsPlugin)
  await ctx.plugin(toolFamiliesPlugin)
  try {
    const service = getService(ctx, nano.tools)
    const state = toolState("main")
    const args = { path: "/client/images/delayed.png" }
    state.toolCatalog = service.list("main").map(({ definition }) => definition)
    const resultPromise = service.execute("image_tool", args, toolContext(state, "image_tool", args))
    for (let attempts = 0; !invocation && attempts < 1000; attempts++) await new Promise<void>((resolve) => setImmediate(resolve))
    assert.ok(invocation, "tool execution must reach the real loopback executor")
    t.mock.timers.tick(30_001)
    await resultPromise
    const toolResult = state.context.items.find((message) => message.role === "toolResult")
    assert.ok(toolResult?.role === "toolResult" && !toolResult.isError)
    const image = state.context.items.find((message) => message.role === "user" && Array.isArray(message.content) && message.content.some((part) => part.type === "image"))
    assert.ok(image, "delayed executor image reaches conversation after the 30-second boundary")
  } finally {
    await ctx.fiber.dispose()
  }
})



const extensionEvent = defineEvent<{ readonly value: string }>("com.example.extension-event")
const echoInput = defineValidator<{ text: string }>((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("text" in value) || typeof value.text !== "string") {
    throw new TypeError("text must be a string")
  }
  return { text: value.text }
})
const echoOutput = defineValidator<string>((value) => {
  if (typeof value !== "string") throw new TypeError("output must be a string")
  return value
})
const extensionEcho = defineOperation("com.example.echo", { input: echoInput, output: echoOutput })

test("public commands, RPC operations, and listeners execute and clean up without services", async () => {
  const ctx = await createHost()
  const observedEvents: string[] = []
  const healthyEvents: string[] = []
  const extension: Plugin = {
    name: "com.example.commands-and-rpc",
    inject: ["nano.contributions"],
    apply(ctx) {
      registerCommand(ctx, "example.echo", { id: "example.echo", description: "Echo a command input", execute(input, context) { context.signal.throwIfAborted(); return `${context.subject ?? "anonymous"}:${String(input)}` } })
      onEvent(ctx, extensionEvent, ({ value }) => { observedEvents.push(value); if (value === "fail") throw new Error("contained listener failure") })
      registerOperation(ctx, extensionEcho, async (input, context) => { context.signal.throwIfAborted(); if (input.text === "fail") throw new Error("contained operation failure"); return `${context.subject}:${input.text}` })
    },
  }
  const extensionFiber = await ctx.plugin(extension)
  await ctx.plugin({ name: "com.example.healthy-listener", apply(ctx) { onEvent(ctx, extensionEvent, ({ value }) => { healthyEvents.push(value) }) } })
  const command = listContributions(ctx, nano.commands).find(({ key }) => key === "example.echo")
  assert.ok(command)
  assert.equal(await command.value.execute("hello", { signal: new AbortController().signal, subject: "operator" }), "operator:hello")
  const operation = listContributions(ctx, nano.operations).find(({ key }) => key === extensionEcho.name)
  assert.ok(operation)
  const operationContext = { signal: new AbortController().signal, subject: "external-client" }
  assert.equal(await operation.value.handler({ text: "hello" }, operationContext), "external-client:hello")
  await assert.rejects(async () => operation.value.handler({ text: "fail" }, operationContext), /contained operation failure/)
  await emitEvent(ctx, extensionEvent, { value: "ok" })
  await assert.rejects(emitEvent(ctx, extensionEvent, { value: "fail" }))
  assert.deepEqual(observedEvents, ["ok", "fail"])
  assert.deepEqual(healthyEvents, ["ok", "fail"])
  await extensionFiber.dispose()
  assert.equal(listContributions(ctx, nano.commands).some(({ key }) => key === "example.echo"), false)
  assert.equal(listContributions(ctx, nano.operations).some(({ key }) => key === extensionEcho.name), false)
  await emitEvent(ctx, extensionEvent, { value: "after-disable" })
  assert.deepEqual(observedEvents, ["ok", "fail"])
  assert.deepEqual(healthyEvents, ["ok", "fail", "after-disable"])
  await ctx.fiber.dispose()
})

test("third-party tools execute through the public tools service with genuine loop context", async () => {
  const ctx = await createHost()
  const toolName = "com_example_echo"
  const loopState = {
    context: new Context({ model }), pendingInputs: [], tokenCount: 0, contextSize: 0, toolCatalog: [], toolCatalogEpoch: 0, toolCatalogFingerprint: "", toolInFlight: false,
    memoryRecallCooldowns: {}, memoryRecallTurn: 0, memoryRecallPending: false, shutdownRequested: false, turnInFlight: false, restRequested: false, restReason: "",
  } satisfies ToolContributionContext["state"]
  const hooks = { waitForEvent: async () => null, waitForEventWithTimeout: async (_timeoutMs: number) => null, injectIncomingEvent(_convId: number, _event: ToolContributionContext["state"]["pendingInputs"][number]) {}, flushDeferredEvents() {}, refreshToolCatalog(_reason: "post-compaction") {}, clearSession: async () => {}, saveSession: async () => {}, saveShutdownSnapshot: async () => {}, shouldShutdown: () => false, resolveShutdown() {} } satisfies ToolContributionContext["hooks"]
  const contribution: ToolContribution = {
    definition: { type: "function", function: { name: toolName, description: "Echo a value from an extension", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } } },
    execute(input, context) {
      assert.equal(context.state, loopState); assert.equal(context.hooks, hooks); assert.equal(context.call.id, "call-1"); assert.deepEqual(context.args, { value: "from-model" })
      if (input.value === "fail") throw new Error("contained tool failure")
      return `${context.convId}:${context.call.name}:${String(input.value)}`
    },
  }
  const extension: Plugin = { name: "com.example.tool-contribution", inject: ["nano.contributions"], apply(ctx) { registerTool(ctx, toolName, contribution) } }
  await ctx.plugin(toolsPlugin)
  const extensionFiber = await ctx.plugin(extension)
  const context: ToolContributionContext = { signal: new AbortController().signal, convId: 42, state: loopState, hooks, call: { type: "toolCall", id: "call-1", name: toolName, arguments: { value: "from-model" } }, args: { value: "from-model" } }
  const service = getService(ctx, nano.tools)
  assert.deepEqual(service.list().map(({ definition }) => definition.function.name), [toolName])
  await assert.rejects(service.execute(toolName, { value: "fail" }, context), /contained tool failure/)
  assert.equal(await service.execute(toolName, { value: "from-model" }, context), "42:com_example_echo:from-model")
  await extensionFiber.dispose()
  assert.deepEqual(service.list(), [])
  await assert.rejects(service.execute(toolName, { value: "from-model" }, context), /unavailable/)
  await ctx.fiber.dispose()
})

test("an external command follows native required-service availability", async () => {
  const greeting = defineService<{ greet(name: string): string }>("example.greeting")
  const ctx = await createHost()
  const provider = (prefix: string): Plugin => ({
    name: `example.greeting-provider-${prefix}`,
    apply(ctx) { ctx.provide(greeting.name, { greet: (name: string) => `${prefix}:${name}` }) },
  })
  const extension: Plugin = {
    name: "example.greeting-extension", inject: [greeting.name, "nano.contributions"],
    apply(ctx) {
      const service = getService(ctx, greeting)
      registerCommand(ctx, "example.greet", { id: "example.greet", execute: (input) => service.greet(String(input)) })
    },
  }
  try {
    const extensionFiber = await ctx.plugin(extension)
    const invoke = async () => {
      const command = listContributions(ctx, nano.commands).find(({ key }) => key === "example.greet")
      assert.ok(command)
      return command.value.execute("operator", { signal: new AbortController().signal })
    }
    assert.deepEqual(listContributions(ctx, nano.commands), [])
    const first = await ctx.plugin(provider("first"))
    await extensionFiber.await()
    assert.equal(await invoke(), "first:operator")
    await first.dispose()
    await extensionFiber.await()
    assert.deepEqual(listContributions(ctx, nano.commands), [])
    await ctx.plugin(provider("second"))
    await extensionFiber.await()
    assert.equal(await invoke(), "second:operator")
    await extensionFiber.dispose()
    assert.deepEqual(listContributions(ctx, nano.commands), [])
  } finally {
    await ctx.fiber.dispose()
  }
})
