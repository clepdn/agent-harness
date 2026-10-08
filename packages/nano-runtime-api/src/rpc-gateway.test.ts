import assert from "node:assert/strict"
import test from "node:test"
import Fastify, { type FastifyInstance } from "fastify"
import WebSocket from "ws"
import { defineOperation, defineStream, defineValidator, RpcValidationError } from "@nano/protocol"
import type { OperationContribution, RpcAuthService, StreamContribution } from "@nano/protocol/rpc"
import { createRpcGateway } from "./rpc-gateway"
import type { SlotContribution } from "@nano/plugins"

function hasStringValue(value: unknown): value is { value: string } {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("value" in value)) return false
  return typeof value.value === "string"
}

const input = defineValidator<{ value: string }>((value) => {
  if (!hasStringValue(value)) throw new RpcValidationError("input must contain a string value")
  return value
})
const output = defineValidator<{ value: string }>((value) => {
  if (!hasStringValue(value)) throw new RpcValidationError("output must contain a string value")
  return value
})
const item = defineValidator<{ value: string }>((value) => {
  if (!hasStringValue(value)) throw new RpcValidationError("item must contain a string value")
  return value
})

const echo = defineOperation("test.echo", { input, output, permission: "test.read" })
const stream = defineStream("test.stream", { input, item, permission: "test.stream" })

type AnyContribution = OperationContribution | StreamContribution
type Contribution<T extends AnyContribution> = SlotContribution<T>

function contribution<T extends AnyContribution>(key: string, value: T, owner = "test"): Contribution<T> {
  return { key, value, owner }
}

function auth(mode: RpcAuthService["mode"] = "local-open", permissions: readonly string[] = ["*"]): RpcAuthService {
  return { mode, allowedOrigins: [], permissions, ...(mode === "token" ? { token: "secret" } : {}) }
}

async function makeApp(options: {
  operations?: () => readonly Contribution<OperationContribution>[]
  streams?: () => readonly Contribution<StreamContribution>[]
  auth?: () => RpcAuthService | undefined
  authenticate?: Parameters<typeof createRpcGateway>[0]["authenticate"]
  authorize?: Parameters<typeof createRpcGateway>[0]["authorize"]
  maxFrameBytes?: number
} = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const gateway = createRpcGateway({
    operations: options.operations ?? (() => []),
    streams: options.streams ?? (() => []),
    auth: options.auth ?? (() => auth()),
    authenticate: options.authenticate,
    authorize: options.authorize,
    maxFrameBytes: options.maxFrameBytes,
  })
  await app.register(gateway.http)
  await app.register(gateway.websocket)
  await app.ready()
  return app
}

async function withApp<T>(options: Parameters<typeof makeApp>[0], run: (app: FastifyInstance) => Promise<T>): Promise<T> {
  const app = await makeApp(options)
  try {
    return await run(app)
  } finally {
    await app.close()
  }
}

function json(response: { json(): unknown }): unknown {
  return response.json()
}

function waitForMessage(socket: WebSocket, predicate: (frame: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      let frame: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(data.toString())
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
        frame = parsed as Record<string, unknown>
      } catch {
        return
      }
      if (!predicate(frame)) return
      cleanup()
      resolve(frame)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onClose = () => {
      cleanup()
      reject(new Error("socket closed before expected frame"))
    }
    const cleanup = () => {
      socket.off("message", onMessage)
      socket.off("error", onError)
      socket.off("close", onClose)
    }
    socket.on("message", onMessage)
    socket.on("error", onError)
    socket.on("close", onClose)
  })
}

async function connect(app: FastifyInstance): Promise<WebSocket> {
  await app.listen({ host: "127.0.0.1", port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address === "object")
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/rpc/stream`)
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve())
    socket.once("error", reject)
  })
  return socket
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return
  await new Promise<void>((resolve) => {
    socket.once("close", () => resolve())
    socket.close()
  })
}

test("local-open rejects remote peers even when Host and forwarding headers claim localhost", async () => {
  let calls = 0
  await withApp({ operations: () => [contribution<OperationContribution<typeof echo>>("test.echo", {
    descriptor: echo,
    handler: (value) => { calls++; return value },
  })] }, async (app) => {
    const request = { method: "POST" as const, url: "/rpc/test.echo", payload: { input: { value: "proof" } } }
    const remote = await app.inject({ ...request, remoteAddress: "192.0.2.10", headers: { host: "localhost", "x-forwarded-for": "127.0.0.1" } })
    assert.equal(remote.statusCode, 401)
    assert.equal(calls, 0)
    const local = await app.inject({ ...request, remoteAddress: "127.0.0.1", headers: { host: "localhost" } })
    assert.equal(local.statusCode, 200)
    assert.deepEqual(local.json(), { value: { value: "proof" } })
    assert.equal(calls, 1)
  })
})

test("HTTP operations enforce token permissions and sanitize handler failures", async () => {
  let calls = 0
  await withApp({
    operations: () => [contribution<OperationContribution<typeof echo>>("test.echo", {
      descriptor: echo,
      handler: async (value) => {
        calls++
        if (value.value === "secret failure") throw new Error("database password=do-not-leak")
        return { value: value.value.toUpperCase() }
      },
    })],
    auth: () => auth("token", ["test.other"]),
  }, async (app) => {
    const unauthenticated = await app.inject({ method: "POST", url: "/rpc/test.echo", payload: { input: { value: "x" } } })
    assert.equal(unauthenticated.statusCode, 401)
    assert.deepEqual(json(unauthenticated), { error: { code: "UNAUTHENTICATED", message: "Authentication required" } })

    const denied = await app.inject({
      method: "POST", url: "/rpc/test.echo", headers: { authorization: "Bearer secret" }, payload: { input: { value: "x" } },
    })
    assert.equal(denied.statusCode, 403)
    assert.deepEqual(json(denied), { error: { code: "PERMISSION_DENIED", message: "Permission denied" } })
    assert.equal(calls, 0)

    const permissionChanged = auth("token", ["test.read"])
    const allowedApp = await makeApp({
      operations: () => [contribution<OperationContribution<typeof echo>>("test.echo", {
        descriptor: echo,
        handler: async (value) => {
          calls++
          if (value.value === "secret failure") throw new Error("database password=do-not-leak")
          return { value: value.value.toUpperCase() }
        },
      })],
      auth: () => permissionChanged,
    })
    try {
      const invalid = await allowedApp.inject({
        method: "POST", url: "/rpc/test.echo", headers: { authorization: "Bearer secret" }, payload: { input: { value: 7 } },
      })
      assert.equal(invalid.statusCode, 400)
      assert.deepEqual(json(invalid), { error: { code: "INVALID_ARGUMENT", message: "input must contain a string value" } })

      const failed = await allowedApp.inject({
        method: "POST", url: "/rpc/test.echo", headers: { authorization: "Bearer secret" }, payload: { input: { value: "secret failure" } },
      })
      assert.equal(failed.statusCode, 500)
      assert.deepEqual(json(failed), { error: { code: "INTERNAL", message: "Internal RPC error" } })
      assert.equal(JSON.stringify(json(failed)).includes("do-not-leak"), false)

      const ok = await allowedApp.inject({
        method: "POST", url: "/rpc/test.echo", headers: { authorization: "Bearer secret" }, payload: { input: { value: "hello" } },
      })
      assert.equal(ok.statusCode, 200)
      assert.deepEqual(json(ok), { value: { value: "HELLO" } })
    } finally {
      await allowedApp.close()
    }
  })
})

test("HTTP operations reject malformed output and remove exports live", async () => {
  let active = true
  const contributionValue = contribution("test.echo", {
    descriptor: echo,
    handler: () => ({ value: "valid" }),
  })
  await withApp({
    operations: () => active ? [contributionValue] : [],
  }, async (app) => {
    const first = await app.inject({ method: "POST", url: "/rpc/test.echo", payload: { input: { value: "x" } } })
    assert.equal(first.statusCode, 200)

    active = false
    const removed = await app.inject({ method: "POST", url: "/rpc/test.echo", payload: { input: { value: "x" } } })
    assert.equal(removed.statusCode, 404)

    active = true
    const malformed = contribution("test.echo", {
      descriptor: echo,
      handler: () => ({ value: 42 } as never),
    })
    const replaced = () => [malformed]
    const replaceApp = await makeApp({ operations: replaced })
    try {
      const response = await replaceApp.inject({ method: "POST", url: "/rpc/test.echo", payload: { input: { value: "x" } } })
      assert.equal(response.statusCode, 400)
      assert.deepEqual(json(response), { error: { code: "INVALID_ARGUMENT", message: "output must contain a string value" } })
    } finally {
      await replaceApp.close()
    }
  })
})
test("HTTP cancellation aborts a handler when its contribution unloads", async () => {
  const owner = new AbortController()
  let resolveEntered!: () => void
  const entered = new Promise<void>((resolve) => { resolveEntered = resolve })
  const app = await makeApp({
    operations: () => [contribution("test.echo", {
      descriptor: echo,
      signal: owner.signal,
      handler: async (_value, context) => {
        resolveEntered()
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve()
          else context.signal.addEventListener("abort", () => resolve(), { once: true })
        })
        throw Object.assign(new Error("cancelled"), { code: "CANCELLED" })
      },
    })],
  })
  try {
    const pending = Promise.resolve(app.inject({ method: "POST", url: "/rpc/test.echo", payload: { input: { value: "x" } } }))
    await entered
    owner.abort()
    const response = await pending
    assert.equal(response.statusCode, 499)
    const body = json(response)
    assert.ok(body && typeof body === "object" && "error" in body)
    assert.ok(body.error && typeof body.error === "object" && "code" in body.error)
    assert.equal(body.error.code, "CANCELLED")
  } finally {
    await app.close()
  }
})
test("WebSocket authenticates tokens, multiplexes streams, cancels, and handles live removal", async () => {
  const owner = new AbortController()
  let resolveCancelled!: () => void
  const cancelled = new Promise<void>((resolve) => { resolveCancelled = resolve })
  const streams: Array<Contribution<StreamContribution<typeof stream>>> = [contribution<StreamContribution<typeof stream>>("test.stream", {
    descriptor: stream,
    signal: owner.signal,
    handler: async (value, context) => {
      async function* items(): AsyncIterable<{ value: string }> {
        yield { value: `${value.value}:one` }
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve()
          else context.signal.addEventListener("abort", () => resolve(), { once: true })
        })
        if (context.signal.aborted) {
          if (value.value === "a") resolveCancelled()
          return
        }
        yield { value: `${value.value}:two` }
      }
      return items()
    },
  })]
  let removed = false
  await withApp({ streams: () => removed ? [] : streams, auth: () => auth("token", ["test.stream"]) }, async (app) => {
    const socket = await connect(app)
    try {
      socket.send(JSON.stringify({ op: "auth", token: "wrong" }))
      const authFailure = await waitForMessage(socket, (frame) => frame.op === "auth")
      assert.deepEqual(authFailure, { op: "auth", ok: false, error: { code: "UNAUTHENTICATED", message: "Authentication required" } })
    } finally {
      await closeSocket(socket)
    }
  })

  await withApp({ streams: () => removed ? [] : streams, auth: () => auth("token", ["test.stream"]) }, async (app) => {
    const socket = await connect(app)
    try {
      socket.send(JSON.stringify({ op: "auth", token: "secret" }))
      assert.deepEqual(await waitForMessage(socket, (frame) => frame.op === "auth"), { op: "auth", ok: true })

      const aItem = waitForMessage(socket, (frame) => frame.op === "item" && frame.id === "a")
      const bItem = waitForMessage(socket, (frame) => frame.op === "item" && frame.id === "b")
      socket.send(JSON.stringify({ id: "a", op: "subscribe", method: "test.stream", input: { value: "a" } }))
      socket.send(JSON.stringify({ id: "b", op: "subscribe", method: "test.stream", input: { value: "b" } }))
      const [first, second] = await Promise.all([aItem, bItem])
      assert.deepEqual(new Set([first.id, second.id]), new Set(["a", "b"]))
      const firstValue = first.value as { value: string }
      const secondValue = second.value as { value: string }
      assert.deepEqual([firstValue, secondValue].sort((left, right) => left.value.localeCompare(right.value)), [{ value: "a:one" }, { value: "b:one" }])

      socket.send(JSON.stringify({ id: "a", op: "cancel" }))
      await cancelled
      socket.send(JSON.stringify({ id: "removed", op: "subscribe", method: "missing", input: { value: "x" } }))
      assert.deepEqual(await waitForMessage(socket, (frame) => frame.id === "removed"), {
        id: "removed", op: "error", error: { code: "NOT_FOUND", message: "RPC stream not found" },
      })
      removed = true
      socket.send(JSON.stringify({ id: "gone", op: "subscribe", method: "test.stream", input: { value: "x" } }))
      assert.deepEqual(await waitForMessage(socket, (frame) => frame.id === "gone"), {
        id: "gone", op: "error", error: { code: "NOT_FOUND", message: "RPC stream not found" },
      })
      owner.abort()
    } finally {
      await closeSocket(socket)
    }
  })
})

test("WebSocket stream input and item validation produce protocol errors", async () => {
  const badInput = contribution<StreamContribution<typeof stream>>("test.stream", {
    descriptor: stream,
    handler: async function* () { yield { value: "never" } },
  })
  await withApp({ streams: () => [badInput] }, async (app) => {
    const socket = await connect(app)
    try {
      socket.send(JSON.stringify({ id: "bad", op: "subscribe", method: "test.stream", input: { value: 1 } }))
      assert.deepEqual(await waitForMessage(socket, (frame) => frame.id === "bad"), {
        id: "bad", op: "error", error: { code: "INVALID_ARGUMENT", message: "input must contain a string value" },
      })
    } finally {
      await closeSocket(socket)
    }
  })

  const malformed = contribution<StreamContribution<typeof stream>>("test.stream", {
    descriptor: stream,
    handler: async function* () { yield { value: 42 } as never },
  })
  await withApp({ streams: () => [malformed] }, async (app) => {
    const socket = await connect(app)
    try {
      socket.send(JSON.stringify({ id: "bad-output", op: "subscribe", method: "test.stream", input: { value: "x" } }))
      assert.deepEqual(await waitForMessage(socket, (frame) => frame.id === "bad-output"), {
        id: "bad-output", op: "error", error: { code: "INVALID_ARGUMENT", message: "item must contain a string value" },
      })
    } finally {
      await closeSocket(socket)
    }
  })
})
