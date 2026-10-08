import type Database from "better-sqlite3"
import type { ClientToolExecutor, ToolDefinition } from "@nano/harness-core"
import type { ToolCapability, WorkspaceDescriptor } from "@nano/harness-protocol"
import type { JsonValue, StreamEvent, TriggerSource, WorkerEvent, WorkerEventType, WorkerModelSnapshot, WorkerOperationResult } from "@nano/protocol"
import { nanoOperations, nanoStreams, nanoRpcAuth } from "@nano/protocol/rpc"
import { defineEvent, defineService, defineSlot, listContributions, registerContribution } from "@nano/plugins"
import type { CordisContext, Cleanup, SlotContribution } from "@nano/plugins"
import type { AssistantMessage, AssistantMessageEventStream, CompletionContext, Message, Model, OpenAICompletionsOptions, PrepareModelMessages, Usage } from "./llm"
import type { ModelProviderResolver } from "./model-api"
import { modelProviders } from "./model-api"
import type { UserMessage } from "./types"
import type { CompactionStrategy, SubagentConfig } from "./config"
import type { CompactionResult, LoopHooks, LoopState, ManualCompactionRequest, RuntimeKind } from "./runner/types"
import type { FunctionToolCall } from "./runner/loop-shared"
import type { InterruptRequestResult, ModelSwapResult } from "./runner/index"
import type { DeepArchiveBackend } from "./runner/compaction-companion"
import type { SummaryOptions } from "./runner/summarize"
import type { ModelSwapSelection, RuntimeModelConfig } from "./runner/model-state"
import type { SwitchableToolClient } from "./client/switchable"
import type { ContextImageReference } from "./context-images"
import type { MemoryApplicationService } from "./memory"
import type { MetricsStore } from "./metrics"
import type { SessionStore } from "./runner/session"
import type { ContextStoreService } from "./runner/context-store"
import type { JobManager } from "./runner/jobs"
import type { AgentChannelService } from "./runner/agent-channel"
import type { WebSearchService } from "./web-search"
import type * as RemoteImage from "./remote-image"
import type { BootstrapCapabilities, PriorRestContext } from "./bootstrap"
import type { FrontendSoulReconciliation } from "./frontend-soul"
import type { ClassifiedApiError } from "./api-errors"
import type { DiscordMessageTarget } from "./types"
import type { ContextImageAttachment } from "./context-images"
import type { DiscordMemorySearchResult } from "./memory/shared"
import type { DiscordChannel, DiscordMessage } from "@nano/protocol"
import type { GuildMember } from "discord.js"

export { CordisContext, Fiber, Service, Contributions, configSchema, defineService, defineSlot, defineEvent, getService, findService, registerContribution, listContributions, watchContributions, onEvent, emitEvent } from "@nano/plugins"
export type { Plugin, FiberState, Inject, Cleanup, ServiceToken, SlotToken, EventToken, SlotContribution } from "@nano/plugins"
export { registerOperation, registerStream } from "@nano/protocol/rpc"
export type { OperationContribution, StreamContribution, RpcAuthConfig, RpcAuthService, OperationHandlerContext } from "@nano/protocol/rpc"

export interface BootstrapApplicationService {
  build(event: UserMessage, priorRest?: PriorRestContext | null, options?: BootstrapCapabilities): Promise<Message[]>
  ensureSoulFilePlacement(): Promise<void>
  reconcileFrontendSoul(): Promise<FrontendSoulReconciliation>
  readFrontendSoul(): Promise<string>
  writeFrontendSoul(expectedSoul: string, content: string): Promise<{ patchPath: string; conflicted: boolean }>
}

export interface DiscordSendMessageParams {
  channelId?: string
  content: string
  target?: unknown
  sourceItemId?: string
  referenceMessage?: string
  replyMode?: string
  turnTargets?: readonly DiscordMessageTarget[]
  runtimeKind?: RuntimeKind
}
export interface DiscordUploadFileParams extends DiscordSendMessageParams {
  filePath: string
}
export interface DiscordApplicationService {
  readonly available: boolean
  channels(): readonly DiscordChannel[]
  messages(channelId: string, before?: string, limit?: number): readonly DiscordMessage[]
  ingress(body: JsonValue, signal?: AbortSignal): Promise<WorkerOperationResult>
  searchMessages(query: string, limit: number, queryVector?: number[], runtimeKind?: RuntimeKind): Promise<readonly DiscordMemorySearchResult[]>
  listDiscordChannels(runtimeKind?: RuntimeKind): readonly unknown[]
  listDiscordInbox(limit?: number, status?: string[] | string, runtimeKind?: RuntimeKind): readonly unknown[]
  listDiscordBackread(channelId: string, limit?: number, beforeMessageId?: string, runtimeKind?: RuntimeKind): readonly unknown[]
  markDiscordItem(itemId: string, status: "pending" | "seen" | "acted" | "ignored", note?: string, action?: "none" | "replied" | "messaged" | "dismissed" | "noted", runtimeKind?: RuntimeKind): void
  scanDiscordChannels(params?: { limit?: number; channelIds?: string[] | string; beforeMessageId?: string; runtimeKind?: RuntimeKind }): Promise<Record<string, unknown>>
  sendDiscordMessage(params: DiscordSendMessageParams): Promise<Record<string, unknown>>
  uploadDiscordFile(params: DiscordUploadFileParams): Promise<Record<string, unknown>>
  setDiscordChannelNote(channelId: string, note: string, runtimeKind?: RuntimeKind): Record<string, unknown>
  setCustomStatus(text: string | null): void
  pruneDiscordMemory(id: string, reason: "explicit_request" | "surfaced_incorrect" | "surfaced_stale", note?: string, runtimeKind?: RuntimeKind): Record<string, unknown>
  searchDiscordMessages(params: { channelId: string; query?: string; messageId?: string; limit?: number; runtimeKind?: RuntimeKind }): Promise<Record<string, unknown>>
  setContextSize(tokens: number): void
  setWorking(active: boolean): void
  dispatchTyping(turnId: string, channelId: string): void
  stopTyping(turnId?: string): void
  notifyModelActivity(turnId: string): void
  beginToolWait(turnId: string): void
  endToolWait(turnId: string): void
  clearTypingScope(scope: { discordTypingTurnId?: string; discordTypingChannelId?: string }): void
  reportApiError(error: ClassifiedApiError): Promise<void>
  discordEventImageReferences(event: UserMessage): ContextImageReference[]
  refreshCommands(): Promise<void>
  loadContextAvatar(ref: Extract<ContextImageReference, { kind: "discord-avatar" }>): Promise<ContextImageAttachment>
  loadContextEmoji(ref: Extract<ContextImageReference, { kind: "discord-emoji" }>): Promise<ContextImageAttachment>
  readonly supportedVoices: readonly string[]
  voiceStatus(): { active: boolean; channelId?: string; channelName?: string; guildId?: string; model?: string; voice: string }
  joinVoice(member: GuildMember): Promise<{ active: boolean; channelId?: string; channelName?: string; guildId?: string; model?: string; voice: string }>
  leaveVoice(): Promise<boolean>
  setVoice(name: string): Promise<string>
  sendVoiceReply(id: string, text: string): { ok: boolean; error?: string; chunks?: number }
}

export interface ConversationSubmit { event: UserMessage; runtimeKind?: RuntimeKind }
export interface ConversationResult { accepted: boolean; running: boolean }
export interface ConversationHistoryInput { runtimeKind?: RuntimeKind; limit?: number; before?: number }
export interface ConversationHistoryItem { role: string; content: unknown; timestamp?: number; [key: string]: unknown }
export interface ConversationEvent { seq?: number; event: unknown }
export interface ConversationService {
  submit(input: ConversationSubmit): Promise<ConversationResult> | ConversationResult
  history(input: ConversationHistoryInput): Promise<readonly ConversationHistoryItem[]>
  subscribe(input: { runtimeKind?: RuntimeKind; after?: number; sessionId?: string }, signal?: AbortSignal): AsyncIterable<ConversationEvent>
  cancel(input: { runtimeKind?: RuntimeKind; sessionId?: string }): Promise<void> | void
}
export interface RunnerStatus {
  agentId: string
  running: boolean
  idle: boolean
  tokenCount: number
  contextSize: number
  processStartedAt: string
  uptimeMs: number
}
export interface RunnerService {
  activate(event: UserMessage): void
  wake(event: UserMessage): Promise<void>
  enqueue(event: UserMessage, options?: { onlyIfWaiting?: boolean; priority?: boolean }): boolean
  status(): RunnerStatus
  interrupt(): InterruptRequestResult
  discard(): boolean
  rest(reason: string): boolean
  compact(options?: Partial<ManualCompactionRequest>): boolean
  swapModel(preset: string): Promise<ModelSwapResult>
  modelSnapshot(): WorkerModelSnapshot
  trigger(source: TriggerSource, body: JsonValue, signal?: AbortSignal): Promise<WorkerOperationResult>
}
export interface LifecycleService {
  shutdown(): void
  restart(reason?: string): void
}
export interface ModelService {
  list(): readonly Model[]
  listPresets(): readonly string[]
  resolver(): ModelProviderResolver
  current(runtimeKind?: RuntimeKind): RuntimeModelConfig
  resolveModelSwap(preset: string): ModelSwapSelection
  applyModelSwap(selection: ModelSwapSelection): void
  persistModelSwap(selection: ModelSwapSelection): Promise<void>
  persistedPreset(): string | undefined
  getFastMode(): boolean
  setFastMode(enabled?: boolean): boolean
  serviceTier(model: Pick<Model, "id" | "provider">): "priority" | "default" | undefined
  complete(model: Model, context: CompletionContext, options?: OpenAICompletionsOptions): Promise<AssistantMessage>
  stream(model: Model, context: CompletionContext, options?: OpenAICompletionsOptions): AssistantMessageEventStream
}
export interface ToolContributionContext {
  readonly signal: AbortSignal
  readonly runtimeKind?: RuntimeKind
  readonly sessionId?: string
  readonly convId: number
  readonly state: LoopState
  readonly hooks: LoopHooks
  readonly call: FunctionToolCall
  readonly args: Record<string, unknown>
  readonly onOutput?: (chunk: string) => void
}
export interface ToolCatalogContext {
  readonly runtimeKind: RuntimeKind
  readonly clientCapabilities: ReadonlySet<ToolCapability>
  readonly workspace: WorkspaceDescriptor | null
  readonly vision: boolean
  readonly computer: boolean
}
export interface ToolContribution {
  readonly definition: ToolDefinition
  readonly definitionFor?: (context: ToolCatalogContext) => ToolDefinition
  readonly availableFor?: (context: ToolCatalogContext) => boolean
  readonly runtimeKinds?: readonly RuntimeKind[]
  readonly clientCapabilities?: readonly ToolCapability[]
  readonly requiresVision?: boolean
  readonly requiresComputer?: boolean
  readonly execute: (input: Record<string, unknown>, context: ToolContributionContext) => Promise<unknown> | unknown
}
export interface ToolService {
  list(runtimeKind?: RuntimeKind): readonly ToolContribution[]
  execute(name: string, input: Record<string, unknown>, context: ToolContributionContext): Promise<unknown>
}
export interface CommandContext {
  readonly signal: AbortSignal
  readonly subject?: string
  readonly runtimeKind?: RuntimeKind
}
export interface CommandContribution {
  readonly id: string
  readonly description?: string
  readonly execute: (input: unknown, context: CommandContext) => Promise<unknown> | unknown
  readonly metadata?: unknown
  readonly discord?: unknown
}
export interface RecallProvider {
  recall(messages: readonly Message[], cooldowns: Record<number, number>, turn: number): Promise<{ messages: Message[]; recalledChunkIds: number[] }>
  remember(cooldowns: Record<number, number>, chunkIds: readonly number[], turn: number): Record<number, number>
}
export interface MemoryService extends MemoryApplicationService {}
export interface DiscordService extends DiscordApplicationService {}
export interface ClientFile {
  path: string
  name: string
  mime: string
  data: Buffer
}
export interface ClientService extends ClientToolExecutor {
  start(): Promise<void>
  stop(): Promise<void>
  connect: SwitchableToolClient["connect"]
  disconnect: SwitchableToolClient["disconnect"]
  info: SwitchableToolClient["info"]
  status: SwitchableToolClient["status"]
  capabilities: SwitchableToolClient["getCapabilities"]
  workspace: SwitchableToolClient["getWorkspace"]
  readFile(path: string, maxBytes?: number, timeoutMs?: number): Promise<ClientFile>
}
export interface MetricsService {
  recordMetric: MetricsStore["recordMetric"]
  recordLlmRequest(model: string, status: "success" | "error", usage: Usage | null, tokensPerSecond?: number): void
  setWorking(working: boolean): void
  setApiRequestsInWindow(count: number): void
  setProviderUsageRatio(provider: string, model: string, ratio: number): void
  renderPrometheus(): string
  detail: MetricsStore["getMetricDetail"]
  discordDetail: MetricsStore["getDiscordMetricDetail"]
  list: MetricsStore["getMetrics"]
}
export interface PersistenceService extends SessionStore, ContextStoreService {
  readonly home: string
  init(path?: string): Promise<void>
  close(): Promise<void> | void
  getDb(): Database.Database
  vecAvailable(): boolean
  startConversation(source: string, startedAt: string): number
  logMessage(convId: number, role: string, content: string, toolCalls?: unknown, toolCallId?: string): void
  endConversation(id: number, tokens: number): void
  listConversationHistory(input: ConversationHistoryInput): Promise<readonly ConversationHistoryItem[]>
  history(input: ConversationHistoryInput): Promise<readonly ConversationHistoryItem[]>
  listWorkerEvents(afterSeq?: number, limit?: number, mode?: "after" | "tail"): readonly WorkerEvent[]
  subscribeWorkerEvents(listener: (event: WorkerEvent) => void): () => void
  workerEventBounds(): { oldestSeq: number; latestSeq: number }
  publishWorkerEvent(type: WorkerEventType, payload: unknown): WorkerEvent
  recordStateRevision(filePath: string, source: string): Promise<void>
}
export interface ContextManagementService {
  loadAgentSummaryContext(runtimeKind?: RuntimeKind): Promise<string | null>
  summarizeConversation(messages: readonly Message[], model: Model, apiKey?: string, options?: SummaryOptions): Promise<Message[] | null>
  proactiveCompaction(messages: readonly Message[], model: Model, apiKey: string | undefined, turnAge: number, minChars: number): Promise<{ messages: Message[]; compacted: number; attempted: number }>
  resolveDeepArchiveBackend(provider?: string, forceSnapcompact?: boolean, runtimeModelState?: RuntimeModelConfig): DeepArchiveBackend
  journalCompactionSummary(summaryText: string): Promise<boolean>
  describeContextSummary: ContextStoreService["describeContextSummary"]
  expandContextSummary: ContextStoreService["expandContextSummary"]
  grepContext: ContextStoreService["grepContext"]
  recordRestContextSnapshot: ContextStoreService["recordRestContextSnapshot"]
  archiveContextMessages: ContextStoreService["archiveContextMessages"]
  recordContextCompaction: ContextStoreService["recordContextCompaction"]
}
export interface EventService {
  emit(event: StreamEvent): void
  subscribe(listener: (event: StreamEvent) => void): () => void
  subscribeLive(listener: (event: StreamEvent) => void): () => void
  close(): void
}
export interface CompactionStrategyRequest {
  readonly state: LoopState
  readonly phase: "pre-turn" | "post-turn" | "idle" | "shutdown"
  readonly triggerTokens: number
  readonly force?: boolean
  readonly manual?: ManualCompactionRequest
  readonly runLLM: (strategy: CompactionStrategy, force: boolean, options?: { forceSummaryModel?: boolean; forceSnapcompact?: boolean }) => Promise<CompactionResult>
  readonly runProactive: () => Promise<CompactionResult>
}
export interface StrategyService {
  readonly id: string
  execute(input: CompactionStrategyRequest): Promise<CompactionResult>
}
export interface ImageService {
  prepareMessages: PrepareModelMessages
  fetchRemoteImage: typeof RemoteImage.fetchRemoteImage
  memoryExcerptImageReferences(text: string, path: string): Promise<ContextImageReference[]>
}
export interface BootstrapService extends BootstrapApplicationService {}
export interface EmbeddingsService {
  readonly dimensions: number
  readonly model: string
  configured(): boolean
  embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]>
}
export type JobsService = Pick<JobManager, "cancelRunningJobs" | "hasExecutingJobs" | "cancelJob" | "forgetJob" | "getJob" | "listJobs" | "readJobStdout" | "runJobUntilDetached" | "startJob">
export interface SubagentService {
  findSubagent(name: string): SubagentConfig | undefined
  runSubagent(convId: number, subagent: SubagentConfig, task: string, signal?: AbortSignal, runtimeKind?: RuntimeKind): Promise<string>
}
export type { AgentChannelService, WebSearchService }
export interface RuntimeDelivery {
  readonly runtimeKind: RuntimeKind
  deliver(event: UserMessage): boolean | Promise<boolean>
  waiting(): boolean
  enqueue(event: UserMessage, options?: { onlyIfWaiting?: boolean; priority?: boolean }): boolean
}
export const nano = {
  conversation: defineService<ConversationService>("nano.conversation"),
  runner: defineService<RunnerService>("nano.runner"),
  runtimeDelivery: defineSlot<RuntimeDelivery>("nano.runtime-delivery"),
  lifecycle: defineService<LifecycleService>("nano.lifecycle"),
  images: defineService<ImageService>("nano.images"),
  bootstrap: defineService<BootstrapService>("nano.bootstrap"),
  model: defineService<ModelService>("nano.model"),
  tools: defineService<ToolService>("nano.tools"),
  memory: defineService<MemoryService>("nano.memory"),
  embeddings: defineService<EmbeddingsService>("nano.embeddings"),
  discord: defineService<DiscordService>("nano.discord"),
  client: defineService<ClientService>("nano.client"),
  metrics: defineService<MetricsService>("nano.metrics"),
  persistence: defineService<PersistenceService>("nano.persistence"),
  events: defineService<EventService>("nano.events"),
  jobs: defineService<JobsService>("nano.jobs"),
  subagents: defineService<SubagentService>("nano.subagents"),
  agentChannel: defineService<AgentChannelService>("nano.agent-channel"),
  webSearch: defineService<WebSearchService>("nano.web-search"),
  contextManagement: defineService<ContextManagementService>("nano.context-management"),
  rpcAuth: nanoRpcAuth,
  commands: defineSlot<CommandContribution>("nano.commands"),
  toolContributions: defineSlot<ToolContribution>("nano.tool-contributions"),
  strategies: defineSlot<StrategyService>("nano.strategies"),
  modelProviders,
  operations: nanoOperations,
  streams: nanoStreams,
  eventsChanged: defineEvent<StreamEvent>("nano.events.changed"),
  wake: defineEvent<{ runtimeKind?: RuntimeKind; event: UserMessage; priority?: boolean }>("nano.wake"),
  runtimeReady: defineEvent<RuntimeKind>("nano.runtime-ready"),
} as const

/** Bind tool registration and IO cancellation to the native owner fiber. */
export function registerTool(ctx: CordisContext, key: string, contribution: ToolContribution): Cleanup {
  const controller = new AbortController()
  const unregister = registerContribution(ctx, nano.toolContributions, key, {
    ...contribution,
    execute(input: Record<string, unknown>, context: ToolContributionContext) {
      const signal = AbortSignal.any([controller.signal, context.signal])
      signal.throwIfAborted()
      return contribution.execute(input, { ...context, signal })
    },
  })
  const abort = ctx.effect(() => () => controller.abort())
  return async () => {
    controller.abort()
    await abort()
    await unregister()
  }
}

/** Bind command registration and IO cancellation to the native owner fiber. */
export function registerCommand(ctx: CordisContext, key: string, contribution: CommandContribution): Cleanup {
  const controller = new AbortController()
  const unregister = registerContribution(ctx, nano.commands, key, {
    ...contribution,
    execute(input: unknown, context: CommandContext) {
      const signal = AbortSignal.any([controller.signal, context.signal])
      signal.throwIfAborted()
      return contribution.execute(input, { ...context, signal })
    },
  })
  const abort = ctx.effect(() => () => controller.abort())
  return async () => {
    controller.abort()
    await abort()
    await unregister()
  }
}



export interface IncomingEventEnricher { enrich(event: UserMessage): Promise<UserMessage> | UserMessage }
export interface RuntimeExecutionServices {
  readonly providerResolver: ModelProviderResolver
  readonly model?: ModelService
  readonly memory?: MemoryService
  readonly discord?: DiscordService
  readonly metrics?: MetricsService
  readonly events?: EventService
  readonly persistence?: PersistenceService
  readonly contextManagement?: ContextManagementService
  readonly strategies?: () => readonly SlotContribution<StrategyService>[]
  readonly jobs?: JobsService
  readonly tools?: ToolService
  readonly client?: ClientService
  readonly incoming?: IncomingEventEnricher
  readonly images?: ImageService
  readonly bootstrap?: BootstrapService
  readonly subagents?: SubagentService
  readonly agentChannel?: AgentChannelService
  readonly webSearch?: WebSearchService
}
export const modelProviderResolver = (ctx: CordisContext): ModelProviderResolver =>
  () => listContributions(ctx, nano.modelProviders)
