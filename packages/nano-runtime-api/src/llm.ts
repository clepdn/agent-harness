/**
 * Immutable conversation lineage and cache state.
 *
 * Wire providers are selected through the explicit application-scoped resolver
 * supplied to Context; this module contains no default model adapter.
 */

import { createHash, randomUUID } from "node:crypto"
import {
  completeModel,
  streamModel,
  type ModelProvider,
  type ModelProviderResolver,
  type ProviderCacheRequest,
} from "./model-api"
import { AssistantMessageEventStream } from "./model-events"
import type { AssistantMessageEvent } from "./model-events"
import type { ContextImageAttachment, ContextImageState } from "./contracts/images"

// ── Content part types ────────────────────────────────────────────────────────

export interface TextContent {
  type: "text"
  text: string
  textSignature?: string
}

export interface ThinkingContent {
  type: "thinking"
  thinking: string
  thinkingSignature?: string
  redacted?: boolean
}

export interface ImageContent {
  type: "image"
  data: string // base64 encoded
  mimeType: string
}

export interface ToolCall {
  type: "toolCall"
  id: string
  name: string
  arguments: Record<string, any>
  thoughtSignature?: string
}

// ── Usage ─────────────────────────────────────────────────────────────────────

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}

// ── Stop reason ───────────────────────────────────────────────────────────────

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted"

// ── Message types ──────────────────────────────────────────────────────────────

export interface UserMessage extends ContextImageState {
  role: "user"
  content: string | (TextContent | ImageContent)[]
  timestamp: number
}

export interface AssistantMessage {
  role: "assistant"
  content: (TextContent | ThinkingContent | ToolCall)[]
  api: string
  provider: string
  model: string
  responseModel?: string
  responseId?: string
  usage: Usage
  stopReason: StopReason
  errorMessage?: string
  timestamp: number
}

export interface ToolResultMessage<TDetails = any> extends ContextImageState {
  role: "toolResult"
  toolCallId: string
  toolName: string
  content: (TextContent | ImageContent)[]
  details?: TDetails
  isError: boolean
  timestamp: number
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage

// ── Model ──────────────────────────────────────────────────────────────────────

export type ReasoningEffort = string

export interface ModelEffortCapabilities {
  supportedEfforts: readonly ReasoningEffort[]
  defaultEffort?: ReasoningEffort
  changeMode: "configuration-update" | "cache-reset"
}

export interface ContextEffortUpdate {
  beforeMessageIndex: number
  effort: ReasoningEffort
}

export interface ContextEffortState {
  initialEffort?: ReasoningEffort
  updates: readonly ContextEffortUpdate[]
}

export interface Model {
  id: string
  name: string
  api: string
  provider: string
  baseUrl: string
  reasoning: boolean
  bridge?: boolean
  effortCapabilities?: ModelEffortCapabilities
  input: ("text" | "image")[]
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  contextWindow: number
  maxTokens: number
  headers?: Record<string, string>
}

// ── Tool / Schema types ────────────────────────────────────────────────────────

export type TSchema = Record<string, unknown>

export interface Tool<TParameters extends TSchema = TSchema> {
  name: string
  description: string
  parameters: TParameters
}

// ── Context ────────────────────────────────────────────────────────────────────

/** The wire-level prompt shape accepted by the low-level completion helpers. */
export interface CompletionContext {
  systemPrompt?: string
  messages: Message[]
  tools?: Tool[]
  effortUpdates?: readonly ContextEffortUpdate[]
}

// ── Stream options ─────────────────────────────────────────────────────────────

export type ToolChoice = "auto" | "none" | "required" | { type: "function"; function: { name: string } }

/** Optional application-owned preparation of detached model messages. */
export type PrepareModelMessages = (messages: Message[]) => Promise<void>

export interface StreamOptions {
  includeContextImages?: boolean
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  apiKey?: string
  headers?: Record<string, string>
  timeoutMs?: number
  maxRetries?: number
  /** Required for stateless provider dispatch; Context supplies its own application resolver. */
  providerResolver?: ModelProviderResolver
  prepareMessages?: PrepareModelMessages
  /** Internal provider hook for retaining a provider-owned cache replay request without re-encoding it. */
  onCacheWarmRequest?: (provider: ModelProvider, request: ProviderCacheRequest) => void
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>

export interface OpenAICompletionsOptions extends StreamOptions {
  toolChoice?: ToolChoice
  reasoningEffort?: ReasoningEffort
}

export type ContextForkReason =
  | "fork"
  | "edit"
  | "truncate"
  | "compaction"
  | "sanitize"
  | "image-scrub"
  | "model-change"
  | "tools-change"
  | "settings-change"
  | "restore"
  | "reset"

export interface ContextOptions {
  model: Model
  providerResolver?: ModelProviderResolver
  prepareMessages?: PrepareModelMessages
  systemPrompt?: string
  tools?: Tool[]
  toolChoice?: ToolChoice
  thinkingLevel?: ReasoningEffort
  effortState?: ContextEffortState
  includeContextImages?: boolean
  temperature?: number
  maxTokens?: number
  headers?: Record<string, string>
  apiKey?: string
  items?: readonly Message[]
  id?: string
  parentId?: string
  forkReason?: ContextForkReason
}

export interface ContextCompletionOptions {
  /** Retain the exact successful provider request for cache refreshes. */
  captureCacheWarmRequest?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  maxRetries?: number
  onEvent?: (event: AssistantMessageEvent) => void | Promise<void>
}

export type ContextForkOptions = Partial<Omit<ContextOptions, "id" | "parentId" | "forkReason" | "model">> & {
  model?: Model
  reason?: ContextForkReason
  allowCacheReset?: boolean
}

export type CacheWarmOptions = Pick<ContextCompletionOptions, "signal" | "timeoutMs"> & { mode?: "completion" | "prewarm" }



export type ContextItem = Message & { readonly context: Context }

export class ContextChangedError extends Error {
  constructor(message = "Context changed while completion was in flight") {
    super(message)
    this.name = "ContextChangedError"
  }
}

/** A provider failure before any assistant response was committed to Context. */
export class CompletionRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CompletionRequestError"
  }
}

function cloneMessage(message: Message): Message {
  return structuredClone(message)
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  if (ArrayBuffer.isView(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

function contextItem(owner: Context, message: Message, index: number): ContextItem {
  const item = cloneMessage(message) as ContextItem
  Object.defineProperty(item, "context", {
    configurable: false,
    enumerable: false,
    get: () => owner.forkAt(index),
  })
  return deepFreeze(item)
}

/**
 * One cache lineage of model-visible state.
 *
 * `append` and cache-preserving effort updates extend an existing Context.
 * Changes to earlier items or request configuration return a new Context,
 * making cache-invalidating operations explicit at the call site.
 */
export class Context {
  readonly id: string
  readonly parentId?: string
  readonly forkReason?: ContextForkReason
  readonly model: Model
  readonly systemPrompt?: string
  readonly tools?: readonly Tool[]
  readonly toolChoice?: OpenAICompletionsOptions["toolChoice"]
  private _effortState: ContextEffortState
  readonly includeContextImages: boolean
  readonly temperature?: number
  readonly maxTokens?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly apiKey?: string

  /** Application-bound provider resolver; excluded from config fingerprints and persisted state. */
  private readonly providerResolver?: ModelProviderResolver
  private readonly prepareMessages?: PrepareModelMessages
  private _items: readonly ContextItem[] = Object.freeze([])
  private revision = 0
  private cacheWarmRequest?: {
    provider: ModelProvider
    request: ProviderCacheRequest
    lastUsedAt: number
    lastCompletionAt: number
  }
  private readonly imageHydration = new Map<number, {
    imageAttachments?: ContextImageAttachment[]
    imageNotes?: string[]
  }>()

  constructor(options: ContextOptions) {
    this.id = options.id ?? randomUUID()
    this.parentId = options.parentId
    this.providerResolver = options.providerResolver
    this.prepareMessages = options.prepareMessages
    this.forkReason = options.forkReason
    this.model = deepFreeze(structuredClone(options.model))
    this.systemPrompt = options.systemPrompt
    this.tools = options.tools ? deepFreeze(structuredClone(options.tools)) : undefined
    this.toolChoice = typeof options.toolChoice === "object"
      ? deepFreeze(structuredClone(options.toolChoice))
      : options.toolChoice
    this._effortState = deepFreeze(structuredClone(options.effortState ?? {
      initialEffort: options.thinkingLevel,
      updates: [],
    }))
    this.includeContextImages = options.includeContextImages ?? true
    this.temperature = options.temperature
    this.maxTokens = options.maxTokens
    this.headers = options.headers ? deepFreeze(structuredClone(options.headers)) : undefined
    this.apiKey = options.apiKey
    for (const item of options.items ?? []) this.append(item)
    let previousIndex = -1
    for (const update of this._effortState.updates) {
      if (!Number.isSafeInteger(update.beforeMessageIndex) || update.beforeMessageIndex < 0 ||
          update.beforeMessageIndex > this._items.length || update.beforeMessageIndex <= previousIndex ||
          typeof update.effort !== "string" || !update.effort.trim()) {
        throw new Error("Invalid Context effort update timeline")
      }
      if (update.beforeMessageIndex < this._items.length && this._items[update.beforeMessageIndex]?.role !== "user") {
        throw new Error("Context effort updates must precede a user message")
      }
      previousIndex = update.beforeMessageIndex
    }
  }

  get items(): readonly ContextItem[] {
    return this._items
  }

  get effortState(): ContextEffortState {
    return this._effortState
  }

  get thinkingLevel(): ReasoningEffort | undefined {
    return this._effortState.updates.at(-1)?.effort ?? this._effortState.initialEffort
  }

  get availableEfforts(): readonly ReasoningEffort[] {
    return this.model.bridge ? this.model.effortCapabilities?.supportedEfforts ?? [] : []
  }

  get effortChangeMode(): ModelEffortCapabilities["changeMode"] | undefined {
    return this.availableEfforts.length ? this.model.effortCapabilities?.changeMode : undefined
  }

  /** Append a GPT-6 update, or explicitly accept a new cache lineage. */
  changeEffort(effort: ReasoningEffort, options: { allowCacheReset?: boolean } = {}): Context {
    if (!this.effortChangeMode) throw new Error("Dynamic effort control requires bridge model capability metadata")
    if (!this.availableEfforts.includes(effort)) throw new Error(`Model ${this.model.id} does not support effort ${JSON.stringify(effort)}`)
    if (effort === this.thinkingLevel) return this
    if (this.effortChangeMode === "cache-reset") {
      if (!options.allowCacheReset) throw new Error("Changing this model's effort requires allowCacheReset: true")
      return this.fork({ thinkingLevel: effort, allowCacheReset: true, reason: "settings-change" })
    }
    if (this._effortState.updates.at(-1)?.beforeMessageIndex === this._items.length) {
      throw new Error("Append a user message before another effort update; adjacent updates are not supported")
    }
    this._effortState = deepFreeze({
      ...this._effortState,
      updates: [...this._effortState.updates, { beforeMessageIndex: this._items.length, effort }],
    })
    this.revision += 1
    return this
  }

  get configurationFingerprint(): string {
    return createHash("sha256").update(JSON.stringify({
      model: this.model,
      systemPrompt: this.systemPrompt,
      tools: this.tools,
      toolChoice: this.toolChoice,
      thinkingLevel: this._effortState.initialEffort,
      includeContextImages: this.includeContextImages,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      headers: this.headers,
    })).digest("hex")
  }

  /** Mutable snapshot for persistence or building an explicit fork. */
  snapshot(): Message[] {
    return this._items.map((item, index) => {
      const message = cloneMessage(item)
      if (message.role === "assistant") return message
      const hydrated = this.imageHydration.get(index)
      if (hydrated?.imageAttachments) message.imageAttachments = structuredClone(hydrated.imageAttachments)
      if (hydrated?.imageNotes) message.imageNotes = [...hydrated.imageNotes]
      return message
    })
  }

  append(item: Message | readonly Message[], ...more: Message[]): this {
    const additions = Array.isArray(item) ? [...item, ...more] : [item as Message, ...more]
    if (additions.length === 0) return this
    if (this._effortState.updates.at(-1)?.beforeMessageIndex === this._items.length && additions[0]?.role !== "user") {
      throw new Error("An effort update must be followed by a user message")
    }
    const start = this._items.length
    const next = additions.map((message, offset) => contextItem(this, message, start + offset))
    this._items = Object.freeze([...this._items, ...next])
    this.revision += additions.length
    return this
  }

  fork(options: ContextForkOptions = {}): Context {
    const has = (key: keyof ContextForkOptions) => Object.prototype.hasOwnProperty.call(options, key)
    const model = has("model") ? options.model ?? this.model : this.model
    const items = has("items") ? options.items ?? [] : this._items
    const modelChanged = model.id !== this.model.id || model.baseUrl !== this.model.baseUrl || model.provider !== this.model.provider
    const updatesUnavailable = this._effortState.updates.length > 0 &&
      (!model.bridge || model.effortCapabilities?.changeMode !== "configuration-update" || !model.effortCapabilities.supportedEfforts.length)
    const effortChanged = has("thinkingLevel") && options.thinkingLevel !== this.thinkingLevel
    if (!modelChanged && effortChanged && this.effortChangeMode && !options.allowCacheReset) {
      throw new Error("Use changeEffort() for dynamic effort changes, or explicitly allow a cache reset")
    }
    const preservedPrefix = !has("items") || (items.length <= this._items.length && items.every((item, index) =>
      item === this._items[index] || JSON.stringify(item) === JSON.stringify(this._items[index])))
    const effortState = has("effortState") ? options.effortState
      : modelChanged || effortChanged || updatesUnavailable || !preservedPrefix || options.reason === "compaction" || options.reason === "reset"
        ? { initialEffort: has("thinkingLevel") ? options.thinkingLevel : this.thinkingLevel, updates: [] }
        : {
            initialEffort: this._effortState.initialEffort,
            updates: items.length === this._items.length && options.reason !== "truncate"
              ? this._effortState.updates
              : this._effortState.updates.filter((update) => update.beforeMessageIndex < items.length),
          }
    return new Context({
      model,
      systemPrompt: has("systemPrompt") ? options.systemPrompt : this.systemPrompt,
      tools: has("tools") ? options.tools : this.tools ? [...this.tools] : undefined,
      toolChoice: has("toolChoice") ? options.toolChoice : this.toolChoice,
      thinkingLevel: has("thinkingLevel") ? options.thinkingLevel : this.thinkingLevel,
      effortState,
      includeContextImages: (has("includeContextImages") ? options.includeContextImages : this.includeContextImages) ?? true,
      temperature: has("temperature") ? options.temperature : this.temperature,
      maxTokens: has("maxTokens") ? options.maxTokens : this.maxTokens,
      headers: has("headers") ? options.headers : this.headers ? { ...this.headers } : undefined,
      apiKey: has("apiKey") ? options.apiKey : this.apiKey,
      items,
      parentId: this.id,
      forkReason: options.reason ?? "fork",
      providerResolver: options.providerResolver ?? this.providerResolver,
      prepareMessages: has("prepareMessages") ? options.prepareMessages : this.prepareMessages,
    })
  }

  forkAt(index: number): Context {
    this.assertIndex(index)
    return this.fork({ items: this._items.slice(0, index + 1), reason: "truncate" })
  }

  edit(index: number, replacement: Message): Context {
    this.assertIndex(index)
    const items = this.snapshot().slice(0, index)
    items.push(replacement)
    return this.fork({ items, reason: "edit" })
  }

  private assertIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this._items.length) {
      throw new RangeError(`Context item index ${index} is out of bounds`)
    }
  }

  /** Recreate a persisted lineage without treating restoration as a fresh fork. */
  static restore(options: ContextOptions): Context {
    return new Context({ ...options, forkReason: options.forkReason ?? "restore" })
  }

  private requestContext(messages: Message[], effortState: ContextEffortState): CompletionContext {
    return {
      systemPrompt: this.systemPrompt,
      messages,
      tools: this.tools ? structuredClone([...this.tools]) : undefined,
      effortUpdates: effortState.updates,
    }
  }

  private async requestMessages(): Promise<Message[]> {
    const messages = this.snapshot()
    if (!this.model.input.includes("image") || !this.includeContextImages) return messages
    await this.prepareMessages?.(messages)
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      if (!message || message.role === "assistant") continue
      if (message.imageAttachments?.length || message.imageNotes?.length) {
        this.imageHydration.set(index, {
          ...(message.imageAttachments ? { imageAttachments: structuredClone(message.imageAttachments) } : {}),
          ...(message.imageNotes ? { imageNotes: [...message.imageNotes] } : {}),
        })
      }
    }
    return messages
  }

  private completionOptions(options: ContextCompletionOptions = {}): OpenAICompletionsOptions {
    return {
      includeContextImages: this.includeContextImages,
      providerResolver: this.providerResolver,
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      ...(this.toolChoice ? { toolChoice: this.toolChoice } : {}),
      ...(this._effortState.initialEffort ? { reasoningEffort: this._effortState.initialEffort } : {}),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      ...(this.headers ? { headers: { ...this.headers } } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    }
  }

  /** Complete this lineage and append the assistant response as one atomic step. */
  async complete(options: ContextCompletionOptions = {}): Promise<AssistantMessage> {
    if (this._effortState.updates.at(-1)?.beforeMessageIndex === this._items.length) {
      throw new Error("Append a user message after changing effort before completing")
    }
    const expectedRevision = this.revision
    const effortState = this._effortState
    const messages = await this.requestMessages()
    const { onEvent, captureCacheWarmRequest, ...requestOptions } = options
    const startedAt = Date.now()
    const requestContext = this.requestContext(messages, effortState)
    let capturedCacheRequest: { provider: ModelProvider; request: ProviderCacheRequest } | undefined
    const completionOptions = {
      ...this.completionOptions(requestOptions),
      ...(captureCacheWarmRequest ? { onCacheWarmRequest: (provider: ModelProvider, request: ProviderCacheRequest) => {
        capturedCacheRequest = { provider, request }
      } } : {}),
    }
    let result: AssistantMessage
    if (onEvent) {
      const events = streamModel(this.model, requestContext, completionOptions)
      for await (const event of events) await onEvent(event)
      result = await events.result()
    } else {
      result = await completeModel(this.model, requestContext, completionOptions)
    }
    if (result.stopReason === "error") {
      throw new CompletionRequestError(result.errorMessage ?? "Completion error")
    }
    if (result.stopReason === "aborted") {
      throw new Error(result.errorMessage ?? "Completion aborted")
    }
    if (this.revision !== expectedRevision) {
      throw new ContextChangedError("Context changed while completion was in flight; refusing to append a stale assistant response")
    }
    this.append(result)
    this.cacheWarmRequest = capturedCacheRequest
      ? { ...capturedCacheRequest, lastUsedAt: startedAt, lastCompletionAt: startedAt }
      : undefined
    return result
  }

  get lastCacheUseAt(): number | undefined {
    return this.cacheWarmRequest?.lastUsedAt
  }

  get lastCompletionAt(): number | undefined {
    return this.cacheWarmRequest?.lastCompletionAt
  }

  async warmCache(options: CacheWarmOptions = {}): Promise<Usage | undefined> {
    const request = this.cacheWarmRequest
    if (!request) return undefined
    if (!this.providerResolver?.().some(({ value }) => value === request.provider)) {
      throw new Error(`Model provider ${request.provider.id} is no longer installed; cache warming is unavailable`)
    }
    if (!request.provider.warmCache) {
      throw new Error(`Model provider ${request.provider.id} does not support cache warming`)
    }
    const startedAt = Date.now()
    const usage = await request.provider.warmCache(this.model, request.request, options)
    if (this.cacheWarmRequest === request) request.lastUsedAt = startedAt
    return usage
  }
}

export { AssistantMessageEventStream }
export type { AssistantMessageEvent } from "./model-events"
export function stream(model: Model, context: CompletionContext, options?: OpenAICompletionsOptions): AssistantMessageEventStream {
  return streamModel(model, context, options)
}

export function complete(model: Model, context: CompletionContext, options?: OpenAICompletionsOptions): Promise<AssistantMessage> {
  return completeModel(model, context, options)
}
