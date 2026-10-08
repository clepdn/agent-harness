import { defineSlot, registerContribution } from "@nano/plugins"
import type { CordisContext, Cleanup, SlotContribution } from "@nano/plugins"
import type {
  AssistantMessage,
  CompletionContext,
  Model,
  OpenAICompletionsOptions,
  Usage,
} from "./llm"
import { AssistantMessageEventStream } from "./model-events"
export { AssistantMessageEventStream } from "./model-events"
export type { AssistantMessageEvent } from "./model-events"

export type { PrepareModelMessages } from "./llm"
export interface ProviderCacheWarmOptions {
  signal?: AbortSignal
  timeoutMs?: number
  mode?: "completion" | "prewarm"
}

export type ProviderCacheRequest = object

export interface ModelProvider {
  readonly id: string
  supports(model: Model): boolean
  complete(model: Model, context: CompletionContext, options?: OpenAICompletionsOptions): Promise<AssistantMessage>
  stream(model: Model, context: CompletionContext, options?: OpenAICompletionsOptions): AssistantMessageEventStream
  captureCacheWarmRequest?(model: Model, context: CompletionContext, options?: OpenAICompletionsOptions): ProviderCacheRequest
  warmCache?(model: Model, request: ProviderCacheRequest, options: ProviderCacheWarmOptions): Promise<Usage | undefined>
}

export const modelProviders = defineSlot<ModelProvider>("nano.model-providers")
export type ModelProviderResolver = () => readonly SlotContribution<ModelProvider>[]
/** Register a provider with cancellation owned by its native plugin fiber. */
export function registerModelProvider(ctx: CordisContext, key: string, provider: ModelProvider): Cleanup {
  const controller = new AbortController()
  const combineSignal = (signal?: AbortSignal) => signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
  const registered: ModelProvider = {
    id: provider.id,
    supports(model) {
      return provider.supports(model)
    },
    async complete(model, context, options) {
      const signal = combineSignal(options?.signal)
      signal.throwIfAborted()
      const result = await provider.complete(model, context, { ...options, signal })
      signal.throwIfAborted()
      return result
    },
    stream(model, context, options) {
      const signal = combineSignal(options?.signal)
      signal.throwIfAborted()
      const source = provider.stream(model, context, { ...options, signal })
      const output = new AssistantMessageEventStream()
      const publishError = (error: unknown, reason: "aborted" | "error") => {
        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: provider.id,
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: reason,
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        }
        output.push({ type: "error", reason, error: message })
      }
      const onAbort = () => {
        try {
          signal.throwIfAborted()
        } catch (error) {
          publishError(error, "aborted")
        }
      }
      signal.addEventListener("abort", onAbort, { once: true })

      const forward = async () => {
        try {
          for await (const event of source) {
            signal.throwIfAborted()
            output.push(event)
            if (event.type === "error") return
          }
          signal.throwIfAborted()
          const result = await source.result()
          signal.throwIfAborted()
          output.end(result)
        } catch (error) {
          publishError(error, signal.aborted ? "aborted" : "error")
          throw error
        } finally {
          signal.removeEventListener("abort", onAbort)
        }
      }
      void forward().catch((error) => output.fail(error))
      return output
    },
    ...(provider.captureCacheWarmRequest ? {
      captureCacheWarmRequest(model, context, options) {
        return provider.captureCacheWarmRequest!(model, context, { ...options, signal: combineSignal(options?.signal) })
      },
    } : {}),
    ...(provider.warmCache ? {
      async warmCache(model, request, options = {}) {
        const signal = combineSignal(options.signal)
        signal.throwIfAborted()
        const result = await provider.warmCache!(model, request, { ...options, signal })
        signal.throwIfAborted()
        return result
      },
    } : {}),
  }
  const unregister = registerContribution(ctx, modelProviders, key, registered)
  const abort = ctx.effect(() => () => controller.abort())
  return async () => {
    controller.abort()
    await abort()
    await unregister()
  }
}


function resolveProvider(model: Model, resolver: ModelProviderResolver | undefined): ModelProvider {
  const provider = resolver?.().find(({ value }) => value.supports(model))?.value
  if (!provider) throw new Error(`No model provider is installed for model ${model.id} (api ${model.api})`)
  return provider
}

function captureCacheRequest(provider: ModelProvider, model: Model, context: CompletionContext, options: OpenAICompletionsOptions | undefined): void {
  if (!options?.onCacheWarmRequest || !provider.captureCacheWarmRequest) return
  options.onCacheWarmRequest(provider, provider.captureCacheWarmRequest(model, context, options))
}

export function completeModel(model: Model, context: CompletionContext, options: OpenAICompletionsOptions = {}): Promise<AssistantMessage> {
  const provider = resolveProvider(model, options.providerResolver)
  captureCacheRequest(provider, model, context, options)
  return provider.complete(model, context, options)
}

export function streamModel(model: Model, context: CompletionContext, options: OpenAICompletionsOptions = {}): AssistantMessageEventStream {
  const provider = resolveProvider(model, options.providerResolver)
  captureCacheRequest(provider, model, context, options)
  return provider.stream(model, context, options)
}

export { Context, ContextChangedError, CompletionRequestError } from "./llm"
export type {
  Model,
  CompletionContext,
  OpenAICompletionsOptions,
  AssistantMessage,
  Usage,
  Message,
  UserMessage,
  ToolResultMessage,
  Tool,
  TextContent,
  ThinkingContent,
  ImageContent,
  ToolCall,
  ContextOptions,
  ContextCompletionOptions,
  ContextForkOptions,
  ContextItem,
  ReasoningEffort,
  ContextEffortState,
  ContextEffortUpdate,
} from "./llm"
