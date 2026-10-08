import { defineSlot } from "@nano/plugins"
import type { PluginScope, SlotContribution } from "@nano/plugins"
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
import { createOpenAICompatibleModelProvider } from "./model/openai-compatible"

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
/** Register a provider whose operations are cancelled and observed with its owning plugin. */
export function registerModelProvider(scope: PluginScope, key: string, provider: ModelProvider): () => void {
  const combineSignal = (signal?: AbortSignal) => signal ? AbortSignal.any([scope.signal, signal]) : scope.signal
  const guarded: ModelProvider = {
    id: provider.id,
    supports: scope.guard((model: Model) => provider.supports(model)),
    complete: scope.guard(async (model: Model, context: CompletionContext, options?: OpenAICompletionsOptions) => {
      const signal = combineSignal(options?.signal)
      const result = await provider.complete(model, context, { ...options, signal })
      signal.throwIfAborted()
      return result
    }),
    stream: scope.guard((model: Model, context: CompletionContext, options?: OpenAICompletionsOptions) => {
      const signal = combineSignal(options?.signal)
      const source = provider.stream(model, context, { ...options, signal })
      const output = new AssistantMessageEventStream()
      const forward = scope.guard(async () => {
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
          const reason = scope.signal.aborted || options?.signal?.aborted ? "aborted" : "error"
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
          throw error
        }
      })
      void forward().catch((error) => output.fail(error))
      return output
    }),
    ...(provider.captureCacheWarmRequest ? { captureCacheWarmRequest: scope.guard((model: Model, context: CompletionContext, options?: OpenAICompletionsOptions) =>
      provider.captureCacheWarmRequest!(model, context, { ...options, signal: combineSignal(options?.signal) })) } : {}),
    ...(provider.warmCache ? { warmCache: scope.guard(async (model: Model, request: ProviderCacheRequest, options: ProviderCacheWarmOptions = {}) => {
      const signal = combineSignal(options.signal)
      const result = await provider.warmCache!(model, request, { ...options, signal })
      signal.throwIfAborted()
      return result
    }) } : {}),
  }
  return scope.register(modelProviders, key, guarded)
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

export { createOpenAICompatibleModelProvider }
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
