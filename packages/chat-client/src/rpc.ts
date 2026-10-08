import { workerEvents } from "@nano/protocol"
import type {
  OperationDescriptor,
  OperationInput,
  OperationOutput,
  RpcError,
  RpcStreamEnvelope,
  StreamDescriptor,
  StreamInput,
  StreamItem,
  Validator,
} from "@nano/protocol"

export type RpcFetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>

export interface RpcSocket {
  readonly readyState: number
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type RpcSocketConstructor = new (url: string) => RpcSocket

export interface CreateRpcClientOptions {
  url: string
  token?: string
  fetchImpl?: RpcFetch
  WebSocketImpl?: RpcSocketConstructor
  maxFrameBytes?: number
}

export interface RpcCallOptions {
  signal?: AbortSignal
}

export interface RpcStreamOptions<T> extends RpcCallOptions {
  onItem(item: T): void
}

export interface RpcClient {
  call<D extends OperationDescriptor>(descriptor: D, input: OperationInput<D>, options?: RpcCallOptions): Promise<OperationOutput<D>>
  stream<D extends StreamDescriptor>(descriptor: D, input: StreamInput<D>, options: RpcStreamOptions<StreamItem<D>>): Promise<void>
  close(): void
}

export class RpcClientError extends Error {
  readonly code: RpcError["code"]

  constructor(error: RpcError) {
    super(error.message)
    this.name = "RpcClientError"
    this.code = error.code
  }
}

interface RpcPending {
  id: string
  method: string
  input: unknown
  lastItem?: unknown
  lastDurableSeq: number
  resumeInput(input: unknown, lastItem: unknown, lastDurableSeq: number): unknown
  handleItem(value: unknown): void
  resolve(): void
  reject(error: unknown): void
  signal?: AbortSignal
  abort?: () => void
}

const DEFAULT_MAX_FRAME_BYTES = 1_000_000
const SOCKET_OPEN = 1

function isRpcErrorCode(value: unknown): value is RpcError["code"] {
  switch (value) {
    case "INVALID_ARGUMENT":
    case "UNAUTHENTICATED":
    case "PERMISSION_DENIED":
    case "NOT_FOUND":
    case "CANCELLED":
    case "UNAVAILABLE":
    case "INTERNAL":
      return true
    default:
      return false
  }
}

function parseError(value: unknown, fallback: RpcError["code"] = "INTERNAL"): RpcError {
  if (typeof value === "object" && value !== null && !Array.isArray(value) &&
    "code" in value && isRpcErrorCode(value.code) && "message" in value && typeof value.message === "string") {
    return { code: value.code, message: value.message }
  }
  return { code: fallback, message: "RPC request failed" }
}

function abortError(): RpcClientError {
  return new RpcClientError({ code: "CANCELLED", message: "RPC request cancelled" })
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function readMessageData(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value)
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value)
  throw new RpcClientError({ code: "INVALID_ARGUMENT", message: "RPC frame must be text" })
}

function decodeEnvelope(value: unknown): RpcStreamEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("op" in value)) {
    throw new RpcClientError({ code: "INVALID_ARGUMENT", message: "Invalid RPC frame" })
  }
  if (value.op === "auth") {
    if ("ok" in value && value.ok === true) return { op: "auth", ok: true }
    if ("ok" in value && value.ok === false) return { op: "auth", ok: false, error: parseError("error" in value ? value.error : undefined, "UNAUTHENTICATED") }
    throw new RpcClientError({ code: "INVALID_ARGUMENT", message: "Invalid RPC auth frame" })
  }
  if (!("id" in value) || typeof value.id !== "string" || value.id.length === 0) {
    throw new RpcClientError({ code: "INVALID_ARGUMENT", message: "Invalid RPC frame id" })
  }
  if (value.op === "item") return { id: value.id, op: "item", value: "value" in value ? value.value : undefined }
  if (value.op === "end") return { id: value.id, op: "end" }
  if (value.op === "error") return { id: value.id, op: "error", error: parseError("error" in value ? value.error : undefined) }
  throw new RpcClientError({ code: "INVALID_ARGUMENT", message: "Invalid RPC frame operation" })
}

function responseErrorCode(status: number): RpcError["code"] {
  if (status === 400) return "INVALID_ARGUMENT"
  if (status === 401) return "UNAUTHENTICATED"
  if (status === 403) return "PERMISSION_DENIED"
  if (status === 404) return "NOT_FOUND"
  if (status === 499) return "CANCELLED"
  if (status === 503) return "UNAVAILABLE"
  return "INTERNAL"
}

export function createRpcClient(options: CreateRpcClientOptions): RpcClient {
  const baseUrl = options.url.replace(/\/$/, "")
  const socketUrl = `${baseUrl.replace(/^http/i, "ws")}/rpc/stream`
  const maxFrameBytes = Math.max(1, options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES)
  const fetchImpl = options.fetchImpl ?? fetch
  let socket: RpcSocket | undefined
  let connecting: Promise<RpcSocket> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let retryDelay = 100
  const streams = new Map<string, RpcPending>()
  const subscribed = new WeakMap<RpcSocket, Set<string>>()

  const send = (current: RpcSocket, message: unknown): void => {
    const serialized = JSON.stringify(message)
    if (bytes(serialized) > maxFrameBytes) throw new RpcClientError({ code: "INVALID_ARGUMENT", message: "RPC frame exceeds configured limit" })
    current.send(serialized)
  }

  const removeStream = (stream: RpcPending): boolean => {
    if (!streams.delete(stream.id)) return false
    stream.signal?.removeEventListener("abort", stream.abort!)
    return true
  }

  const failStream = (stream: RpcPending, error: unknown): void => {
    if (removeStream(stream)) stream.reject(error)
  }

  const finishStream = (stream: RpcPending): void => {
    if (removeStream(stream)) stream.resolve()
  }

  const failAllStreams = (error: unknown): void => {
    for (const stream of streams.values()) failStream(stream, error)
  }

  const handleEnvelope = (frame: RpcStreamEnvelope, current: RpcSocket): void => {
    if (frame.op === "auth") {
      if (!frame.ok) {
        const error = new RpcClientError(frame.error)
        failAllStreams(error)
        try { current.close(4401, "Authentication failed") } catch {}
      }
      return
    }
    const stream = streams.get(frame.id)
    if (!stream) return
    if (frame.op === "item") {
      try {
        stream.handleItem(frame.value)
      } catch (error) {
        failStream(stream, error)
        try { if (current.readyState === SOCKET_OPEN) send(current, { id: stream.id, op: "cancel" }) } catch {}
      }
    } else if (frame.op === "end") {
      finishStream(stream)
    } else {
      failStream(stream, new RpcClientError(frame.error))
    }
  }

  const subscribe = (current: RpcSocket, stream: RpcPending): void => {
    let ids = subscribed.get(current)
    if (!ids) { ids = new Set(); subscribed.set(current, ids) }
    if (ids.has(stream.id) || !streams.has(stream.id)) return
    const input = stream.resumeInput(stream.input, stream.lastItem, stream.lastDurableSeq)
    send(current, { id: stream.id, op: "subscribe", method: stream.method, input })
    ids.add(stream.id)
  }

  const subscribeAll = (current: RpcSocket): void => {
    for (const stream of streams.values()) {
      try { subscribe(current, stream) } catch (error) { failStream(stream, error) }
    }
  }

  const scheduleReconnect = (): void => {
    if (closed || streams.size === 0 || reconnectTimer !== undefined) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void openSocket().catch(() => scheduleReconnect())
    }, retryDelay)
    retryDelay = Math.min(retryDelay * 2, 5_000)
  }

  const openSocket = (): Promise<RpcSocket> => {
    if (closed) return Promise.reject(new RpcClientError({ code: "CANCELLED", message: "RPC client is closed" }))
    if (socket?.readyState === SOCKET_OPEN) return Promise.resolve(socket)
    if (connecting) return connecting
    const Socket: RpcSocketConstructor | undefined = options.WebSocketImpl ?? globalThis.WebSocket
    if (!Socket) return Promise.reject(new RpcClientError({ code: "UNAVAILABLE", message: "WebSocket is not available" }))

    let resolveConnection!: (value: RpcSocket) => void
    let rejectConnection!: (error: unknown) => void
    let settled = false
    const attempt = new Promise<RpcSocket>((resolve, reject) => {
      resolveConnection = resolve
      rejectConnection = reject
    })
    connecting = attempt
    const settle = (error?: unknown, current?: RpcSocket): void => {
      if (settled) return
      settled = true
      if (error !== undefined) rejectConnection(error)
      else if (current) resolveConnection(current)
    }

    let current: RpcSocket
    try {
      current = new Socket(socketUrl)
      socket = current
    } catch (error) {
      if (connecting === attempt) connecting = undefined
      settle(error)
      scheduleReconnect()
      return attempt
    }

    current.onopen = () => {
      retryDelay = 100
      if (options.token !== undefined) {
        try { send(current, { op: "auth", token: options.token }) }
        catch (error) { settle(error); current.close(1002, "Unable to send auth frame") }
      } else {
        subscribeAll(current)
        settle(undefined, current)
      }
    }
    current.onerror = () => {
      settle(new RpcClientError({ code: "UNAVAILABLE", message: "WebSocket connection failed" }))
      try { current.close() } catch {}
    }
    current.onclose = () => {
      if (socket === current) socket = undefined
      if (connecting === attempt) connecting = undefined
      settle(new RpcClientError({ code: "UNAVAILABLE", message: "WebSocket connection closed" }))
      scheduleReconnect()
    }
    current.onmessage = (event) => {
      let frame: RpcStreamEnvelope
      try {
        const text = readMessageData(event.data)
        if (bytes(text) > maxFrameBytes) throw new RpcClientError({ code: "INVALID_ARGUMENT", message: "RPC frame exceeds configured limit" })
        frame = decodeEnvelope(JSON.parse(text))
      } catch (error) {
        failAllStreams(error)
        try { if (current.readyState === SOCKET_OPEN) current.close(1002, "Invalid RPC frame") } catch {}
        settle(error)
        return
      }
      if (frame.op === "auth") {
        if (frame.ok) {
          subscribeAll(current)
          settle(undefined, current)
        } else {
          const error = new RpcClientError(frame.error)
          failAllStreams(error)
          settle(error)
          try { current.close(4401, "Authentication failed") } catch {}
        }
        return
      }
      handleEnvelope(frame, current)
    }
    void attempt.finally(() => { if (connecting === attempt) connecting = undefined }).catch(() => {})
    return attempt
  }

  const call = async <D extends OperationDescriptor>(descriptor: D, input: OperationInput<D>, callOptions: RpcCallOptions = {}): Promise<OperationOutput<D>> => {
    if (callOptions.signal?.aborted) throw abortError()
    const parsedInput = descriptor.input.parse(input)
    const url = `${baseUrl}/rpc/${encodeURIComponent(descriptor.name)}`
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: JSON.stringify({ input: parsedInput }),
        signal: callOptions.signal,
      })
    } catch (error) {
      if (callOptions.signal?.aborted) throw abortError()
      throw error
    }
    if (callOptions.signal?.aborted) throw abortError()
    let body: unknown
    try { body = await response.json() } catch { body = undefined }
    if (callOptions.signal?.aborted) throw abortError()
    if (!response.ok) {
      const error = typeof body === "object" && body !== null && !Array.isArray(body) && "error" in body ? body.error : undefined
      throw new RpcClientError(parseError(error, responseErrorCode(response.status)))
    }
    if (typeof body !== "object" || body === null || Array.isArray(body) || !("value" in body)) {
      throw new RpcClientError({ code: "INTERNAL", message: "Invalid RPC response" })
    }
    const validator = descriptor.output as Validator<OperationOutput<D>>
    return validator.parse(body.value)
  }

  const stream = async <D extends StreamDescriptor>(descriptor: D, input: StreamInput<D>, streamOptions: RpcStreamOptions<StreamItem<D>>): Promise<void> => {
    if (streamOptions.signal?.aborted) throw abortError()
    const parsedInput = descriptor.input.parse(input)
    const resume = descriptor.resume
    let resolveResult!: () => void
    let rejectResult!: (error: unknown) => void
    const pending: RpcPending = {
      id: crypto.randomUUID(),
      method: descriptor.name,
      input: parsedInput,
      lastDurableSeq: descriptor === workerEvents && typeof parsedInput === "object" && parsedInput !== null && !Array.isArray(parsedInput) && "afterSeq" in parsedInput && typeof parsedInput.afterSeq === "number" ? parsedInput.afterSeq : 0,
      resumeInput: (currentInput, lastItem, lastDurableSeq) => {
        if (descriptor === workerEvents && typeof currentInput === "object" && currentInput !== null && !Array.isArray(currentInput)) {
          return descriptor.input.parse({ ...currentInput, ...(lastDurableSeq > 0 ? { afterSeq: lastDurableSeq } : {}) })
        }
        if (lastItem !== undefined && resume) return descriptor.input.parse(resume(descriptor.input.parse(currentInput), descriptor.item.parse(lastItem)))
        return descriptor.input.parse(currentInput)
      },
      handleItem: (value) => {
        const validator = descriptor.item as Validator<StreamItem<D>>
        const item = validator.parse(value)
        if (descriptor === workerEvents && typeof item === "object" && item !== null) {
          if ("seq" in item && typeof item.seq === "number" && "volatile" in item && typeof item.volatile === "boolean") {
            pending.lastItem = item
            if (!item.volatile && item.seq > 0) {
              if (item.seq <= pending.lastDurableSeq) return
              pending.lastDurableSeq = item.seq
            }
          } else if ("after" in item && typeof item.after === "number" && "availableFrom" in item && typeof item.availableFrom === "number" && "latest" in item && typeof item.latest === "number") {
            pending.lastItem = item
            if (item.after < item.latest) pending.lastDurableSeq = item.latest
          }
        } else {
          pending.lastItem = item
        }
        streamOptions.onItem(item)
      },
      resolve: () => resolveResult(),
      reject: (error) => rejectResult(error),
      signal: streamOptions.signal,
    }
    const result = new Promise<void>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
      pending.abort = () => {
        if (!removeStream(pending)) return
        try {
          const current = socket
          if (current?.readyState === SOCKET_OPEN && subscribed.get(current)?.has(pending.id)) send(current, { id: pending.id, op: "cancel" })
        } catch {}
        reject(abortError())
      }
      streams.set(pending.id, pending)
      streamOptions.signal?.addEventListener("abort", pending.abort, { once: true })
      if (streamOptions.signal?.aborted) pending.abort()
      void openSocket().then((current) => {
        if (!streams.has(pending.id)) return
        try { subscribe(current, pending) } catch (error) { failStream(pending, error) }
      }).catch((error: unknown) => {
        if (error instanceof RpcClientError && error.code === "UNAUTHENTICATED") failAllStreams(error)
        scheduleReconnect()
      })
    })
    return result
  }

  const close = (): void => {
    if (closed) return
    closed = true
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    failAllStreams(new RpcClientError({ code: "CANCELLED", message: "RPC client closed" }))
    socket?.close(1000, "client closed")
    socket = undefined
  }

  return { call, stream, close }
}
