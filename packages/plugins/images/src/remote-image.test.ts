import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "@nano/runtime-api/llm"
import { fetchRemoteImage } from "./remote-image"
import { createNiriToolCatalog } from "@nano/plugin-tools"
import { executeToolCall } from "@nano/plugin-runner/loop-tool-runtime"
import type { LoopHooks, LoopState } from "@nano/runtime-api/contracts/runner"
import { config } from "@nano/runtime-api/config"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=", "base64")

test("remote image loader accepts public HTTP images and returns a model artifact", async () => {
  const requested: string[] = []
  const image = await fetchRemoteImage("https://images.example/photo.png", undefined, {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (url) => {
      requested.push(String(url))
      return new Response(png, { headers: { "content-length": String(png.length), "content-type": "image/png" } })
    },
  })
  assert.deepEqual(requested, ["https://images.example/photo.png"])
  assert.equal(image.path, "https://images.example/photo.png")
  assert.equal(image.mime, "image/png")
  assert.equal(image.bytes, png.length)
  assert.match(image.dataUrl, /^data:image\/png;base64,/)
})

test("remote image loader blocks private destinations, including redirects", async () => {
  let fetches = 0
  const fetchImage = async () => {
    fetches++
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private.png" } })
  }
  await assert.rejects(
    () => fetchRemoteImage("https://images.example/photo.png", undefined, {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetch: fetchImage,
    }),
    /public addresses/,
  )
  assert.equal(fetches, 1)

  await assert.rejects(
    () => fetchRemoteImage("http://127.0.0.1/private.png", undefined, { fetch: fetchImage }),
    /public addresses/,
  )
  assert.equal(fetches, 1)
})

test("remote image loader enforces the image byte limit before reading", async () => {
  await assert.rejects(
    () => fetchRemoteImage("https://8.8.8.8/photo.png", undefined, {
      maxBytes: png.length - 1,
      fetch: async () => new Response(png, { headers: { "content-length": String(png.length) } }),
    }),
    /exceeds.*byte limit/,
  )
})

test("frontend can invoke URL image_tool without a client executor", async (t) => {
  const vision = config.model.vision
  config.model.vision = true
  const { createExecutionServices } = await import("../../../../tests/support/runtime-services")
  const fixture = await createExecutionServices()
  config.model.vision = vision
  t.after(() => fixture.close())
  const executionServices = fixture.services
  const model = executionServices.model.current("frontend").fallbackModel
  const convId = executionServices.persistence.startConversation("test", new Date().toISOString())
  t.mock.method(globalThis, "fetch", async () => new Response(png, { headers: { "content-type": "image/png" } }))
  const state: LoopState = {
    runtimeKind: "frontend",
    context: new Context({ model, providerResolver: executionServices.providerResolver }),
    pendingInputs: [],
    tokenCount: 0,
    contextSize: 0,
    toolCatalog: createNiriToolCatalog({ frontend: true, vision: true, contributions: executionServices.tools.list("frontend") }),
    toolCatalogEpoch: 1,
    toolCatalogFingerprint: "",
    toolInFlight: false,
    memoryRecallCooldowns: {},
    memoryRecallTurn: 0,
    memoryRecallPending: false,
    shutdownRequested: false,
    turnInFlight: false,
    services: executionServices,
    restRequested: false,
    restReason: "",
  }
  const hooks = {
    waitForEvent: async () => null,
    waitForEventWithTimeout: async () => null,
    injectIncomingEvent() {},
    flushDeferredEvents() {},
    refreshToolCatalog() {},
    clearSession: async () => {},
    saveSession: async () => {},
    saveShutdownSnapshot: async () => {},
    shouldShutdown: () => false,
    resolveShutdown() {},
  } satisfies LoopHooks
  await executeToolCall(convId, state, hooks, {
    type: "toolCall",
    id: "url-image",
    name: "image_tool",
    arguments: { path: "https://8.8.8.8/photo.png", note: "inspect this" },
  })

  assert.ok(state.context.items.some((message) => message.role === "toolResult" && message.toolCallId === "url-image" && !message.isError))
  const imageMessage = state.context.items.find((message) => message.role === "user")
  assert.equal(imageMessage?.role, "user")
  assert.equal(Array.isArray(imageMessage?.content) && imageMessage.content[1]?.type, "image")
})
