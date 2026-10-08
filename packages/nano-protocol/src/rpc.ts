import { defineService, defineSlot } from "@nano/plugins"
import type { PluginScope } from "@nano/plugins"
import type { OperationDescriptor, OperationInput, OperationOutput, StreamDescriptor, StreamInput, StreamItem } from "./index.js"

export interface OperationHandlerContext {
  readonly signal: AbortSignal
  readonly subject: string
}

export interface OperationContribution<D extends OperationDescriptor = OperationDescriptor> {
  readonly descriptor: D
  readonly signal?: AbortSignal
  readonly handler: (input: OperationInput<D>, context: OperationHandlerContext) => OperationOutput<D> | Promise<OperationOutput<D>>
}

export interface StreamContribution<D extends StreamDescriptor = StreamDescriptor> {
  readonly descriptor: D
  readonly signal?: AbortSignal
  readonly handler: (input: StreamInput<D>, context: OperationHandlerContext) => AsyncIterable<StreamItem<D>> | Promise<AsyncIterable<StreamItem<D>>>
}

export interface RpcAuthConfig {
  readonly mode: "local-open" | "token"
  readonly token?: string
  readonly allowedOrigins?: readonly string[]
  readonly permissions?: readonly string[]
}

export interface RpcAuthService {
  readonly mode: RpcAuthConfig["mode"]
  readonly token?: string
  readonly allowedOrigins: readonly string[]
  readonly permissions: readonly string[]
}

export const nanoOperations = defineSlot<OperationContribution>("nano.operations")
export const nanoStreams = defineSlot<StreamContribution>("nano.streams")
export const nanoRpcAuth = defineService<RpcAuthService>("nano.rpc-auth")

export function registerOperation<D extends OperationDescriptor>(
  scope: PluginScope,
  descriptor: D,
  handler: OperationContribution<D>["handler"],
): () => void {
  const guarded = scope.guard(async (input: unknown, context: OperationHandlerContext): Promise<unknown> => {
    const parsedInput = descriptor.input.parse(input) as OperationInput<D>
    const result = await handler(parsedInput, context)
    return descriptor.output.parse(result)
  })
  return scope.register(nanoOperations, descriptor.name, { descriptor, handler: guarded, signal: scope.signal })
}

export function registerStream<D extends StreamDescriptor>(
  scope: PluginScope,
  descriptor: D,
  handler: StreamContribution<D>["handler"],
): () => void {
  const guarded = scope.guard(async (input: unknown, context: OperationHandlerContext): Promise<AsyncIterable<unknown>> => {
    const parsedInput = descriptor.input.parse(input) as StreamInput<D>
    const source = await handler(parsedInput, context)
    async function* validateItems(): AsyncIterable<unknown> {
      for await (const item of source) yield descriptor.item.parse(item)
    }
    return validateItems()
  })
  return scope.register(nanoStreams, descriptor.name, { descriptor, handler: guarded, signal: scope.signal })
}

export function parseRpcAuthConfig(value: unknown): RpcAuthConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("RPC auth config must be an object")
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("RPC auth config must be a plain object")
  const input = value as Record<string, unknown>
  const allowed: Record<string, true> = { mode: true, token: true, permissions: true, allowedOrigins: true }
  if (Object.keys(input).some((key) => !allowed[key])) throw new TypeError("RPC auth config contains an unsupported field")
  if (input.mode !== "local-open" && input.mode !== "token") throw new TypeError("RPC auth mode must be local-open or token")
  if (input.mode === "token" && (typeof input.token !== "string" || !input.token.trim())) throw new TypeError("Token RPC auth requires a token")
  if (input.mode === "local-open" && input.token !== undefined) throw new TypeError("Local-open RPC auth must not specify a token")
  if (input.token !== undefined && typeof input.token !== "string") throw new TypeError("RPC auth token must be a string")
  const permissions = input.permissions === undefined ? [] : input.permissions
  const allowedOrigins = input.allowedOrigins === undefined ? [] : input.allowedOrigins
  const validStrings = (items: unknown): items is string[] => Array.isArray(items) && items.every((item) => typeof item === "string" && item.trim().length > 0)
  if (!validStrings(permissions)) throw new TypeError("RPC auth permissions must be non-empty strings")
  if (!validStrings(allowedOrigins)) throw new TypeError("RPC allowedOrigins must be non-empty strings")
  return {
    mode: input.mode,
    ...(input.token === undefined ? {} : { token: input.token }),
    permissions: [...permissions],
    allowedOrigins: [...allowedOrigins],
  }
}
