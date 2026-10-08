import websocket from "@fastify/websocket"
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify"
import type { WebSocket } from "ws"
import type { SlotContribution } from "@nano/plugins"
import { RpcValidationError } from "@nano/protocol"
import type { RpcError, OperationDescriptor, StreamDescriptor, OperationOutput, StreamItem } from "@nano/protocol"
import type {
  OperationContribution,
  RpcAuthService,
  StreamContribution,
} from "@nano/protocol/rpc"

export type {
  OperationContribution,
  OperationHandlerContext,
  RpcAuthConfig,
  RpcAuthService,
  StreamContribution,
} from "@nano/protocol/rpc"

export interface RpcAuthorizationRequest {
  readonly method: string
  readonly permission: string
  readonly input: unknown
  readonly headers: FastifyRequest["headers"]
  readonly hostname: string
  readonly subject?: string
}

export interface RpcGatewayOptions {
  readonly operations: () => readonly SlotContribution<OperationContribution>[]
  readonly streams: () => readonly SlotContribution<StreamContribution>[]
  readonly auth: () => RpcAuthService | undefined
  readonly maxBodyBytes?: number
  readonly maxFrameBytes?: number
  readonly authenticate?: (request: FastifyRequest, token: string | undefined) => Promise<{ subject: string } | null> | { subject: string } | null
  readonly authorize?: (input: { subject: string; method: string; permission: string; input: unknown }) => Promise<boolean> | boolean
}

interface WireRequest {
  id?: unknown
  op?: unknown
  method?: unknown
  input?: unknown
  token?: unknown
}

function isWireRequest(value: unknown): value is WireRequest {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}


const DEFAULT_FRAME_BYTES = 1_000_000
const DEFAULT_BODY_BYTES = 1_000_000
const MAX_ACTIVE_STREAMS = 128
const AUTH_TIMEOUT_MS = 5_000

function errorValue(error: unknown): RpcError {
  if (error instanceof RpcValidationError) return { code: "INVALID_ARGUMENT", message: error.message }
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    const code = error.code
    if (code === "INVALID_ARGUMENT" || code === "UNAUTHENTICATED" || code === "PERMISSION_DENIED" || code === "NOT_FOUND" || code === "CANCELLED" || code === "UNAVAILABLE") {
      return { code, message: error instanceof Error ? error.message : code }
    }
  }
  return { code: "INTERNAL", message: "Internal RPC error" }
}

function statusCode(code: RpcError["code"]): number {
  switch (code) {
    case "INVALID_ARGUMENT": return 400
    case "UNAUTHENTICATED": return 401
    case "PERMISSION_DENIED": return 403
    case "NOT_FOUND": return 404
    case "CANCELLED": return 499
    case "UNAVAILABLE": return 503
    default: return 500
  }
}

function isLocalHost(request: FastifyRequest): boolean {
  const host = request.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
}

function isLocalPeer(request: FastifyRequest): boolean {
  const address = request.raw.socket.remoteAddress?.toLowerCase()
  return address === "::1" || Boolean(address?.match(/^(?:::ffff:)?127\.(?:\d{1,3}\.){2}\d{1,3}$/))
}

function headerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization
  if (!authorization?.startsWith("Bearer ")) return undefined
  return authorization.slice("Bearer ".length)
}

function originAllowed(request: FastifyRequest, auth: RpcAuthService): boolean {
  const origin = request.headers.origin
  if (!origin) return true
  if (auth.allowedOrigins.includes(origin)) return true
  try {
    const originHost = new URL(origin).hostname.toLowerCase()
    return auth.mode === "local-open" && isLocalHost(request) && (originHost === "localhost" || originHost === "127.0.0.1" || originHost === "::1")
  } catch {
    return false
  }
}

function frameSizeAllowed(value: string, maxBytes: number): boolean {
  return Buffer.byteLength(value, "utf8") <= maxBytes
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  if (leftBytes.byteLength !== rightBytes.byteLength) return false
  let mismatch = 0
  for (let index = 0; index < leftBytes.byteLength; index++) mismatch |= leftBytes[index]! ^ rightBytes[index]!
  return mismatch === 0
}

function linkSignal(controller: AbortController, signal?: AbortSignal): () => void {
  if (!signal) return () => {}
  if (signal.aborted) controller.abort(signal.reason)
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener("abort", abort, { once: true })
  return () => signal.removeEventListener("abort", abort)
}

function exportByName<T>(contributions: readonly SlotContribution<T>[], name: string): T | undefined {
  return contributions.find((entry) => entry.key === name)?.value
}

export interface RpcIdentity { readonly subject: string }

export async function authenticateRpcRequest(
  request: FastifyRequest,
  auth: RpcAuthService | undefined,
  options: Pick<RpcGatewayOptions, "authenticate"> = {},
  providedToken?: string,
): Promise<RpcIdentity> {
  if (!auth) throw rpcUnavailable("UNAVAILABLE", "RPC authentication is unavailable")
  if (!originAllowed(request, auth)) throw rpcUnavailable("PERMISSION_DENIED", "Origin is not allowed")
  const token = providedToken ?? headerToken(request)
  if (auth.mode === "token" && (!auth.token || !token || !constantTimeEqual(token, auth.token))) {
    throw rpcUnavailable("UNAUTHENTICATED", "Authentication required")
  }
  const custom = await options.authenticate?.(request, token)
  if (options.authenticate && !custom) throw rpcUnavailable("UNAUTHENTICATED", "Authentication required")
  if (auth.mode === "local-open" && !custom && (!isLocalHost(request) || !isLocalPeer(request))) {
    throw rpcUnavailable("UNAUTHENTICATED", "Local RPC access is limited to localhost")
  }
  return { subject: custom?.subject ?? "local" }
}

export async function authorizeRpcRequest(
  request: RpcAuthorizationRequest,
  auth: RpcAuthService | undefined,
  options: Pick<RpcGatewayOptions, "authorize"> = {},
): Promise<boolean> {
  if (!auth) return false
  if (auth.mode === "token" && !auth.permissions.includes(request.permission) && !auth.permissions.includes("*")) return false
  return await options.authorize?.({
    subject: request.subject ?? "local",
    method: request.method,
    permission: request.permission,
    input: request.input,
  }) ?? true
}
function rpcUnavailable(code: RpcError["code"], message: string): Error & { code: RpcError["code"] } {
  return Object.assign(new Error(message), { code })
}

async function raceRpcAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw rpcUnavailable("CANCELLED", "Request cancelled")
  let abort: (() => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(rpcUnavailable("CANCELLED", "Request cancelled"))
    signal.addEventListener("abort", abort, { once: true })
  })
  try {
    return await Promise.race([promise, cancelled])
  } finally {
    if (abort) signal.removeEventListener("abort", abort)
  }
}

export async function invokeRpcOperation<D extends OperationDescriptor>(
  options: RpcGatewayOptions,
  descriptor: D,
  input: unknown,
  request: FastifyRequest,
  signal?: AbortSignal,
  identity?: RpcIdentity,
): Promise<OperationOutput<D>> {
  const auth = options.auth()
  const authenticated = identity ?? await authenticateRpcRequest(request, auth, options)
  const contribution = exportByName(options.operations(), descriptor.name)
  if (!contribution || contribution.descriptor !== descriptor) throw rpcUnavailable("NOT_FOUND", "RPC operation not found")
  const parsedInput = descriptor.input.parse(input)
  const allowed = await authorizeRpcRequest({ method: descriptor.name, permission: descriptor.permission, input: parsedInput, headers: request.headers, hostname: request.hostname, subject: authenticated.subject }, auth, options)
  if (!allowed) throw rpcUnavailable("PERMISSION_DENIED", "Permission denied")
  const controller = new AbortController()
  const unlinkOwner = linkSignal(controller, contribution.signal)
  const unlinkRequest = linkSignal(controller, signal)
  try {
    if (controller.signal.aborted) throw rpcUnavailable("CANCELLED", "Request cancelled")
    const value = await raceRpcAbort(Promise.resolve(contribution.handler(parsedInput, { signal: controller.signal, subject: authenticated.subject })), controller.signal)
    if (controller.signal.aborted) throw rpcUnavailable("CANCELLED", "Request cancelled")
    return descriptor.output.parse(value) as OperationOutput<D>
  } finally {
    unlinkOwner()
    unlinkRequest()
  }
}

export interface PreparedRpcStream<D extends StreamDescriptor> {
  run(signal?: AbortSignal): AsyncGenerator<StreamItem<D>>
}

export async function prepareRpcStream<D extends StreamDescriptor>(
  options: RpcGatewayOptions,
  descriptor: D,
  input: unknown,
  request: FastifyRequest,
  identity?: RpcIdentity,
): Promise<PreparedRpcStream<D>> {
  const auth = options.auth()
  const authenticated = identity ?? await authenticateRpcRequest(request, auth, options)
  const contribution = exportByName(options.streams(), descriptor.name)
  if (!contribution || contribution.descriptor !== descriptor) throw rpcUnavailable("NOT_FOUND", "RPC stream not found")
  const parsedInput = descriptor.input.parse(input)
  const allowed = await authorizeRpcRequest({ method: descriptor.name, permission: descriptor.permission, input: parsedInput, headers: request.headers, hostname: request.hostname, subject: authenticated.subject }, auth, options)
  if (!allowed) throw rpcUnavailable("PERMISSION_DENIED", "Permission denied")

  return {
    async *run(signal?: AbortSignal): AsyncGenerator<StreamItem<D>> {
      const controller = new AbortController()
      const unlinkOwner = linkSignal(controller, contribution.signal)
      const unlinkRequest = linkSignal(controller, signal)
      let iterator: AsyncIterator<unknown> | undefined
      try {
        if (controller.signal.aborted) throw rpcUnavailable("CANCELLED", "Request cancelled")
        const iterable = await raceRpcAbort(Promise.resolve(contribution.handler(parsedInput, { signal: controller.signal, subject: authenticated.subject })), controller.signal) as AsyncIterable<unknown>
        iterator = iterable[Symbol.asyncIterator]()
        while (!controller.signal.aborted) {
          const item = await raceRpcAbort(Promise.resolve(iterator.next()), controller.signal)
          if (item.done) break
          const parsedItem = descriptor.item.parse(item.value) as StreamItem<D>
          yield parsedItem
        }
      } finally {
        if (!controller.signal.aborted) controller.abort()
        if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => {})
        unlinkOwner()
        unlinkRequest()
      }
    },
  }
}

export async function* invokeRpcStream<D extends StreamDescriptor>(
  options: RpcGatewayOptions,
  descriptor: D,
  input: unknown,
  request: FastifyRequest,
  signal?: AbortSignal,
): AsyncGenerator<StreamItem<D>> {
  const prepared = await prepareRpcStream(options, descriptor, input, request)
  yield* prepared.run(signal)
}

export function rpcErrorStatus(error: unknown): number {
  return statusCode(errorValue(error).code)
}
export function rpcErrorValue(error: unknown): RpcError {
  return errorValue(error)
}
export function createRpcGateway(options: RpcGatewayOptions): {
  readonly http: FastifyPluginAsync
  readonly websocket: FastifyPluginAsync
} {
  const maxFrameBytes = Math.max(1, options.maxFrameBytes ?? DEFAULT_FRAME_BYTES)
  const maxBodyBytes = Math.max(1, options.maxBodyBytes ?? DEFAULT_BODY_BYTES)


  const http: FastifyPluginAsync = async (app) => {
    app.post<{ Params: { method: string }; Body: { input?: unknown } }>("/rpc/:method", async (request, reply) => {
      const rawInput = request.body && typeof request.body === "object" ? request.body.input : undefined
      const controller = new AbortController()
      const aborted = () => controller.abort()
      const closed = () => { if (!reply.raw.writableEnded) controller.abort() }
      request.raw.on("aborted", aborted)
      reply.raw.on("close", closed)
      try {
        const identity = await authenticateRpcRequest(request, options.auth(), options)
        const bodySize = Buffer.byteLength(JSON.stringify(request.body ?? null), "utf8")
        if (bodySize > maxBodyBytes) throw rpcUnavailable("INVALID_ARGUMENT", "Request body exceeds configured limit")
        const contribution = exportByName(options.operations(), request.params.method)
        if (!contribution) throw rpcUnavailable("NOT_FOUND", "RPC operation not found")
        const value = await invokeRpcOperation(options, contribution.descriptor, rawInput, request, controller.signal, identity)
        return await reply.send({ value })
      } catch (error) {
        const rpcError = errorValue(error)
        return reply.code(statusCode(rpcError.code)).send({ error: rpcError })
      } finally {
        request.raw.off("aborted", aborted)
        reply.raw.off("close", closed)
      }
    })
  }

  const websocketPlugin: FastifyPluginAsync = async (app) => {
    await app.register(websocket, { options: { maxPayload: maxFrameBytes } })
    app.get("/rpc/stream", { websocket: true }, (connection, request) => {
      const socket = connection as WebSocket
      const aborters = new Map<string, AbortController>()
      let active = 0
      let authContext: RpcIdentity | undefined
      let authTimer: ReturnType<typeof setTimeout> | undefined
      let authenticating: Promise<void> | undefined
      let closed = false

      const send = (frame: unknown): void => {
        if (socket.readyState !== socket.OPEN) return
        const serialized = JSON.stringify(frame)
        if (!frameSizeAllowed(serialized, maxFrameBytes)) {
          socket.close(1009, "Frame exceeds configured limit")
          return
        }
        socket.send(serialized)
      }
      const authenticate = async (token?: string): Promise<void> => {
        const identity = await authenticateRpcRequest(request, options.auth(), options, token)
        authContext = identity
        if (authTimer !== undefined) clearTimeout(authTimer)
        send({ op: "auth", ok: true })
      }
      const failAuthentication = (error: unknown): void => {
        send({ op: "auth", ok: false, error: errorValue(error) })
        socket.close(4401, "Authentication failed")
      }
      const initialAuth = options.auth()
      if (!initialAuth) {
        socket.close(1011, "RPC authentication unavailable")
        return
      }
      if (initialAuth.mode === "local-open") {
        authenticating = authenticate().catch(failAuthentication)
      } else {
        authTimer = setTimeout(() => failAuthentication(rpcUnavailable("UNAUTHENTICATED", "Authentication required")), AUTH_TIMEOUT_MS)
      }
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          socket.close(1003, "Text frames only")
          return
        }
        const raw = data.toString()
        if (!frameSizeAllowed(raw, maxFrameBytes)) {
          socket.close(1009, "Frame exceeds configured limit")
          return
        }
        let message: WireRequest
        try {
          const parsed: unknown = JSON.parse(raw)
          if (!isWireRequest(parsed)) throw new Error("Invalid frame")
          message = parsed
        } catch {
          send({ id: "", op: "error", error: { code: "INVALID_ARGUMENT", message: "Invalid JSON frame" } })
          return
        }
        if (message.op === "auth") {
          const auth = options.auth()
          if (auth?.mode === "local-open" && authContext) {
            send({ op: "auth", ok: true })
            return
          }
          if (typeof message.token !== "string" || !auth || auth.mode !== "token") {
            failAuthentication(rpcUnavailable("UNAUTHENTICATED", "Authentication failed"))
            return
          }
          authenticating = authenticate(message.token).catch(failAuthentication)
          return
        }
        void handleFrame(message)
      })

      async function handleFrame(message: WireRequest): Promise<void> {
        if (message.op === "cancel") {
          if (validRequestId(message.id)) aborters.get(message.id)?.abort()
          return
        }
        if (message.op !== "subscribe" || !validRequestId(message.id) || typeof message.method !== "string") {
          send({ id: validRequestId(message.id) ? message.id : "", op: "error", error: { code: "INVALID_ARGUMENT", message: "Invalid stream request" } })
          return
        }
        if (aborters.has(message.id)) {
          send({ id: message.id, op: "error", error: { code: "INVALID_ARGUMENT", message: "Duplicate stream id" } })
          return
        }
        if (active >= MAX_ACTIVE_STREAMS) {
          send({ id: message.id, op: "error", error: { code: "UNAVAILABLE", message: "Too many active streams" } })
          return
        }
        const controller = new AbortController()
        aborters.set(message.id, controller)
        active++
        try {
          await raceRpcAbort(Promise.resolve(authenticating), controller.signal)
          if (closed || !authContext) throw rpcUnavailable("UNAUTHENTICATED", "Authentication required")
          if (controller.signal.aborted) return
          const descriptor = exportByName(options.streams(), message.method)?.descriptor
          if (!descriptor) throw rpcUnavailable("NOT_FOUND", "RPC stream not found")
          const prepared = await raceRpcAbort(Promise.resolve(prepareRpcStream(options, descriptor, message.input, request, authContext)), controller.signal)
          if (controller.signal.aborted || closed) return
          for await (const item of prepared.run(controller.signal)) {
            if (controller.signal.aborted || closed || socket.readyState !== socket.OPEN) break
            send({ id: message.id, op: "item", value: item })
          }
          if (!controller.signal.aborted && !closed && socket.readyState === socket.OPEN) send({ id: message.id, op: "end" })
        } catch (error) {
          if (!controller.signal.aborted && !closed) send({ id: message.id, op: "error", error: errorValue(error) })
        } finally {
          aborters.delete(message.id)
          active--
        }
      }

      function abortAll(): void {
        clearTimeout(authTimer)
        if (closed) return
        closed = true
        for (const aborter of aborters.values()) aborter.abort()
      }
      socket.on("close", abortAll)
      socket.on("error", abortAll)
    })
  }

  return { http, websocket: websocketPlugin }
}

export async function registerRpcTransport(app: FastifyInstance, options: RpcGatewayOptions): Promise<void> {
  const transport = createRpcGateway(options)
  await app.register(transport.http)
  await app.register(transport.websocket)
}

export function rpcGatewayPlugin(options: RpcGatewayOptions): FastifyPluginAsync {
  const transport = createRpcGateway(options)
  return async (app) => {
    await app.register(transport.http)
    await app.register(transport.websocket)
  }
}
