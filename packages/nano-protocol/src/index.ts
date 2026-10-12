/**
 * Attribution for a live streamed frame: which virtual agent and conversation
 * it belongs to, and which assistant model request (step/attempt) produced it.
 * Runtime-only; never persisted in a conversation snapshot.
 */
export interface StreamIdentity {
  /** Which virtual agent owns the frame. */
  runtimeKind: RuntimeKind
  /** Conversation row (startConversation rowid) owning the frame. */
  conversationId: number
  /** Monotonic assistant-step index within the conversation (1-based). */
  step: number
  /** Provider attempt index within the step (1-based; retries increment). */
  attempt: number
}

/**
 * Live stream frame. Data frames carry an optional `identity`; explicit
 * assistant lifecycle frames require it. Frames without `identity` are legacy
 * wire and must keep decoding for existing consumers.
 */
export type StreamEvent =
  | { type: "text"; text: string; identity?: StreamIdentity }
  | { type: "user"; text: string; source: string; triggeredAt: string; clientId?: string; identity?: StreamIdentity }
  | { type: "thinking"; text: string; identity?: StreamIdentity }
  | { type: "tool"; name: string; args: Record<string, unknown>; result: string; identity?: StreamIdentity }
  | {
      type: "usage"
      promptTokens?: number
      cachedPromptTokens?: number
      cacheWriteTokens?: number
      completionTokens?: number
      totalTokens?: number
      elapsedMs?: number
      tokensPerSecond?: number
      identity?: StreamIdentity
    }
  | { type: "assistant-start"; identity: StreamIdentity }
  | { type: "assistant-end"; identity: StreamIdentity; outcome: "committed" | "abandoned" }
  /** The operator interrupted the active turn; the loop now waits for the next event. */
  | { type: "interrupted"; identity: StreamIdentity }

export type TriggerSource = "discord" | "bsky" | "webhook" | "cron" | "chat"

export interface UserMessage {
  source: TriggerSource
  triggeredAt: string
  content: string
  clientId?: string
  raw: unknown
}

export type WorkerEventType =
  | "worker.hello"
  | "worker.heartbeat"
  | "runner.status"
  | "stream.event"
  | "metric.recorded"
  | "conversation.started"
  | "conversation.message"
  | "conversation.ended"

export interface WorkerEvent<T = unknown> {
  id: string
  agentId: string
  seq: number
  type: WorkerEventType
  createdAt: string
  payload: T
}

export type ControlCommand = {
  type: "event.enqueue"
  event: UserMessage
  options?: { onlyIfWaiting?: boolean; priority?: boolean }
}
export class RpcValidationError extends Error {
  readonly code = "INVALID_ARGUMENT"

  constructor(message: string) {
    super(message)
    this.name = "RpcValidationError"
  }
}

export interface Validator<T> {
  parse(value: unknown): T
}

export function defineValidator<T>(parse: (value: unknown) => T): Validator<T> {
  return { parse: (value) => parse(value) }
}

export interface OperationDescriptor<
  Name extends string = string,
  Input = unknown,
  Output = unknown,
> {
  readonly kind: "operation"
  readonly name: Name
  readonly input: Validator<Input>
  readonly output: Validator<Output>
  readonly permission: string
}

export function defineOperation<const Name extends string, Input, Output>(
  name: Name,
  options: { input: Validator<Input>; output: Validator<Output>; permission?: string },
): OperationDescriptor<Name, Input, Output> {
  return Object.freeze({
    kind: "operation",
    name,
    input: options.input,
    output: options.output,
    permission: options.permission ?? name,
  })
}

export interface StreamDescriptor<
  Name extends string = string,
  Input = unknown,
  Item = unknown,
> {
  readonly kind: "stream"
  readonly name: Name
  readonly input: Validator<Input>
  readonly item: Validator<Item>
  readonly permission: string
  resume?(input: Input, lastItem: Item): Input
}

export function defineStream<const Name extends string, Input, Item>(
  name: Name,
  options: {
    input: Validator<Input>
    item: Validator<Item>
    permission?: string
    resume?: (input: Input, lastItem: Item) => Input
  },
): StreamDescriptor<Name, Input, Item> {
  return Object.freeze({
    kind: "stream",
    name,
    input: options.input,
    item: options.item,
    permission: options.permission ?? name,
    resume: options.resume,
  })
}

export type OperationInput<T> = T extends { readonly input: Validator<infer I> } ? I : never
export type OperationOutput<T> = T extends { readonly output: Validator<infer O> } ? O : never
export type StreamInput<T> = T extends { readonly input: Validator<infer I> } ? I : never
export type StreamItem<T> = T extends { readonly item: Validator<infer E> } ? E : never

export interface RpcError {
  code: "INVALID_ARGUMENT" | "UNAUTHENTICATED" | "PERMISSION_DENIED" | "NOT_FOUND" | "CANCELLED" | "UNAVAILABLE" | "INTERNAL"
  message: string
}

export interface RpcResultEnvelope<T = unknown> {
  id: string
  op: "result"
  value: T
}

export interface RpcErrorEnvelope {
  id: string
  op: "error"
  error: RpcError
}

export interface RpcStreamSubscribeRequest<D extends StreamDescriptor = StreamDescriptor> {
  id: string
  op: "subscribe"
  method: D["name"]
  input: StreamInput<D>
}

export interface RpcStreamCancelRequest {
  id: string
  op: "cancel"
}

export interface RpcAuthRequest {
  op: "auth"
  token: string
}

export type RpcStreamRequest<D extends StreamDescriptor = StreamDescriptor> =
  | RpcStreamSubscribeRequest<D>
  | RpcStreamCancelRequest
  | RpcAuthRequest

export interface RpcStreamItemEnvelope<T = unknown> {
  id: string
  op: "item"
  value: T
}

export interface RpcStreamEndEnvelope {
  id: string
  op: "end"
}

export interface RpcAuthSuccessEnvelope { op: "auth"; ok: true }
export interface RpcAuthFailureEnvelope { op: "auth"; ok: false; error: RpcError }

export type RpcStreamEnvelope<T = unknown> =
  | RpcStreamItemEnvelope<T>
  | RpcStreamEndEnvelope
  | RpcErrorEnvelope
  | RpcAuthSuccessEnvelope
  | RpcAuthFailureEnvelope

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonRecord = { [key: string]: JsonValue }
export interface ReplayStreamItem<T> { seq: number; volatile: boolean; value: T }
export interface ReplayStreamGap { after: number; availableFrom: number; latest: number }
export function toJsonValue(value: unknown): JsonValue {
  const seen = new Set<object>()
  const serialize = (input: unknown): JsonValue => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new TypeError("value contains a non-finite number")
      return input
    }
    if (input === undefined) return null
    if (Array.isArray(input)) {
      if (seen.has(input)) throw new TypeError("value contains a cycle")
      seen.add(input)
      try { return input.map(serialize) } finally { seen.delete(input) }
    }
    if (typeof input !== "object") throw new TypeError("value contains an unsupported type")
    if (seen.has(input)) throw new TypeError("value contains a cycle")
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("value contains a non-plain object")
    seen.add(input)
    try {
      const output: { [key: string]: JsonValue } = {}
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        if (item !== undefined) output[key] = serialize(item)
      }
      return output
    } finally { seen.delete(input) }
  }
  return serialize(value)
}

type RpcJsonObject = Record<string, unknown>

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RpcValidationError(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new RpcValidationError(`${label} must be a plain object`)
  return value as Record<string, unknown>
}

const recordField = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
const isRecord = recordField
const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const stringField = (value: unknown): value is string => typeof value === "string"
const booleanField = (value: unknown): value is boolean => typeof value === "boolean"
const nonNegativeInteger = (value: unknown): value is number => finiteNumber(value) && Number.isInteger(value) && value >= 0
const positiveInteger = (value: unknown): value is number => finiteNumber(value) && Number.isInteger(value) && value > 0
const optionalSequence = (value: RpcJsonObject, key: string): boolean => value[key] === undefined || nonNegativeInteger(value[key])
const optionalLimit = (value: RpcJsonObject, key: string): boolean => value[key] === undefined || positiveInteger(value[key])
const runtimeKindValid = (value: unknown): value is RuntimeKind | undefined => value === undefined || value === "main" || value === "frontend"
const isJsonValue = (value: unknown): value is JsonValue => {
  const ancestors = new Set<object>()
  const visit = (item: unknown): item is JsonValue => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return true
    if (typeof item === "number") return Number.isFinite(item)
    if (typeof item !== "object") return false
    if (ancestors.has(item)) return false
    if (!Array.isArray(item)) {
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) return false
    }
    ancestors.add(item)
    try {
      return Array.isArray(item)
        ? item.every(visit)
        : Object.values(item as Record<string, unknown>).every(visit)
    } finally {
      ancestors.delete(item)
    }
  }
  return visit(value)
}
const hasString = <K extends string>(value: RpcJsonObject, key: K): value is RpcJsonObject & Record<K, string> => typeof value[key] === "string"
const optionalString = (value: RpcJsonObject, key: string): boolean => value[key] === undefined || typeof value[key] === "string"
const optionalNumber = (value: RpcJsonObject, key: string): boolean => value[key] === undefined || finiteNumber(value[key])

function objectValidator<T>(label: string, validate: (value: Record<string, unknown>) => boolean): Validator<T> {
  return defineValidator<T>((value) => {
    const parsed = record(value, label)
    if (!validate(parsed)) throw new RpcValidationError(`${label} has invalid fields`)
    return parsed as T
  })
}

const voidValidator = defineValidator<void>((value) => {
  if (value !== undefined && value !== null) throw new RpcValidationError("expected no result")
  return undefined
})
const agentIdInput = objectValidator<{ agentId: string }>("input", (value): value is Record<string, unknown> & { agentId: string } => hasString(value, "agentId") && value.agentId.length > 0)
const noInput = objectValidator<Record<string, never>>("input", (value): value is Record<string, never> => Object.keys(value).length === 0)

export interface AgentRecord {
  id: string
  name: string
  baseUrl: string
  status: string
  lastSeenAt?: string
  lastSeq: number
}

export interface MirroredCompaction {
  agentId: string
  seq: number
  eventId: string
  metricId?: number
  timestamp: string
  method?: string
  before?: number
  after?: number
  savedTokens?: number
  summary?: string
}

export interface WorkerStatusSnapshot {
  agentId?: string
  running: boolean
  idle: boolean
  tokenCount: number
  contextSize: number
  processStartedAt: string
  uptimeMs: number
  client?: WorkerClientStatus
}

export interface WorkerClientStatus {
  connected: boolean
  agentId: string
  clientId: string
  capabilities: string[]
  workspace: JsonValue | null
  lastSeenAt?: string
  pendingInvocations: number
  remote?: boolean
  connectedAt?: string
}

export interface AgentOverview {
  agent: AgentRecord
  status: WorkerStatusSnapshot | { error: string } | null
  compactions: MirroredCompaction[]
}

export interface AgentEventsPage { agentId: string; events: WorkerEvent[] }
export interface CompactionsPage { agentId: string; compactions: MirroredCompaction[] }
export interface ControlAgentsList { agents: AgentRecord[] }

export interface DiscordChannel {
  channel_id: string
  configured: number | boolean
  guild_id: string | null
  guild_name: string | null
  channel_name: string | null
  channel_type: number | null
  is_dm: number | boolean
  topic: string | null
  note: string | null
  last_note_at: string | null
  last_seen_at: string | null
}

export interface DiscordMessage {
  message_id: string
  channel_id: string
  guild_id: string | null
  author_id: string | null
  author_username: string | null
  content: string
  created_at: string
  is_dm: number | boolean
  mentions_bot: number | boolean
  is_from_bot: number | boolean
}

export interface DiscordChannels { agentId: string; channels: DiscordChannel[] }
export interface DiscordMessages { agentId: string; channelId: string; messages: DiscordMessage[] }

const jsonValidator = defineValidator<JsonValue>((value) => {
  if (!isJsonValue(value)) throw new RpcValidationError("value must be JSON-compatible")
  return value
})

const agentRecordValidator = objectValidator<AgentRecord>("agent", (value): value is Record<string, unknown> & AgentRecord =>
  hasString(value, "id") && hasString(value, "name") && hasString(value, "baseUrl") && hasString(value, "status") &&
  finiteNumber(value.lastSeq) && optionalString(value, "lastSeenAt"))
const compactionValidator = objectValidator<MirroredCompaction>("compaction", (value): value is Record<string, unknown> & MirroredCompaction =>
  hasString(value, "agentId") && finiteNumber(value.seq) && hasString(value, "eventId") && hasString(value, "timestamp") &&
  optionalNumber(value, "metricId") && optionalString(value, "method") && optionalNumber(value, "before") &&
  optionalNumber(value, "after") && optionalNumber(value, "savedTokens") && optionalString(value, "summary"))
const workerClientStatusValidator = objectValidator<WorkerClientStatus>("client status", (value): value is Record<string, unknown> & WorkerClientStatus =>
  booleanField(value.connected) && hasString(value, "agentId") && hasString(value, "clientId") &&
  Array.isArray(value.capabilities) && value.capabilities.every(stringField) &&
  (value.workspace === null || isJsonValue(value.workspace)) && optionalString(value, "lastSeenAt") &&
  finiteNumber(value.pendingInvocations) && (value.remote === undefined || booleanField(value.remote)) && optionalString(value, "connectedAt"))
const workerStatusValidator = objectValidator<WorkerStatusSnapshot>("worker status", (value): value is Record<string, unknown> & WorkerStatusSnapshot =>
  (value.agentId === undefined || stringField(value.agentId)) && booleanField(value.running) && booleanField(value.idle) &&
  finiteNumber(value.tokenCount) && finiteNumber(value.contextSize) && hasString(value, "processStartedAt") &&
  finiteNumber(value.uptimeMs) && (value.client === undefined || isRecord(value.client) && workerClientStatusValidator.parse(value.client) !== undefined))

const agentRowsValidator = defineValidator<ControlAgentsList>((value) => {
  const parsed = record(value, "output")
  if (!Array.isArray(parsed.agents)) throw new RpcValidationError("agents must be an array")
  const agents = parsed.agents.map((agent) => agentRecordValidator.parse(agent))
  return { agents }
})
const agentOverviewValidator = defineValidator<AgentOverview>((value) => {
  const parsed = record(value, "output")
  const agent = agentRecordValidator.parse(parsed.agent)
  let status: AgentOverview["status"]
  if (parsed.status === null) status = null
  else if (isRecord(parsed.status) && "error" in parsed.status) {
    if (!hasString(parsed.status, "error")) throw new RpcValidationError("status error must be a string")
    status = { error: parsed.status.error }
  } else status = workerStatusValidator.parse(parsed.status)
  if (!Array.isArray(parsed.compactions)) throw new RpcValidationError("compactions must be an array")
  const compactions = parsed.compactions.map((item) => compactionValidator.parse(item))
  return { agent, status, compactions }
})
const agentEventsValidator = defineValidator<AgentEventsPage>((value) => {
  const parsed = record(value, "output")
  if (!hasString(parsed, "agentId") || !Array.isArray(parsed.events)) throw new RpcValidationError("events page is invalid")
  const events = parsed.events.map((event) => workerEventValidator.parse(event))
  return { agentId: parsed.agentId, events }
})
const compactionsPageValidator = defineValidator<CompactionsPage>((value) => {
  const parsed = record(value, "output")
  if (!hasString(parsed, "agentId") || !Array.isArray(parsed.compactions)) throw new RpcValidationError("compactions page is invalid")
  const compactions = parsed.compactions.map((item) => compactionValidator.parse(item))
  return { agentId: parsed.agentId, compactions }
})
const discordChannelValidator = (value: unknown): value is DiscordChannel => {
  if (!isRecord(value)) return false
  return hasString(value, "channel_id") && (typeof value.configured === "boolean" || finiteNumber(value.configured)) &&
    (value.guild_id === null || stringField(value.guild_id)) && (value.guild_name === null || stringField(value.guild_name)) &&
    (value.channel_name === null || stringField(value.channel_name)) && (value.channel_type === null || finiteNumber(value.channel_type)) &&
    (typeof value.is_dm === "boolean" || finiteNumber(value.is_dm)) && (value.topic === null || stringField(value.topic)) &&
    (value.note === null || stringField(value.note)) && (value.last_note_at === null || stringField(value.last_note_at)) &&
    (value.last_seen_at === null || stringField(value.last_seen_at))
}
const discordMessageValidator = (value: unknown): value is DiscordMessage => {
  if (!isRecord(value)) return false
  return hasString(value, "message_id") && hasString(value, "channel_id") &&
    (value.guild_id === null || stringField(value.guild_id)) && (value.author_id === null || stringField(value.author_id)) &&
    (value.author_username === null || stringField(value.author_username)) && hasString(value, "content") && hasString(value, "created_at") &&
    (typeof value.is_dm === "boolean" || finiteNumber(value.is_dm)) && (typeof value.mentions_bot === "boolean" || finiteNumber(value.mentions_bot)) &&
    (typeof value.is_from_bot === "boolean" || finiteNumber(value.is_from_bot))
}
const controlDiscordChannelsValidator = defineValidator<DiscordChannels>((value) => {
  const parsed = record(value, "output")
  if (!hasString(parsed, "agentId") || !Array.isArray(parsed.channels) || !parsed.channels.every(discordChannelValidator)) throw new RpcValidationError("Discord channels are invalid")
  return { agentId: parsed.agentId, channels: parsed.channels }
})
const controlDiscordMessagesValidator = defineValidator<DiscordMessages>((value) => {
  const parsed = record(value, "output")
  if (!hasString(parsed, "agentId") || !hasString(parsed, "channelId") || !Array.isArray(parsed.messages) || !parsed.messages.every(discordMessageValidator)) throw new RpcValidationError("Discord messages are invalid")
  return { agentId: parsed.agentId, channelId: parsed.channelId, messages: parsed.messages }
})
const workerEventArrayValidator = defineValidator<readonly WorkerEvent[]>((value) => {
  if (!Array.isArray(value)) throw new RpcValidationError("events must be an array")
  return value.map((event) => workerEventValidator.parse(event))
})
const workerStatusOutput = defineValidator<WorkerStatusSnapshot>((value) => workerStatusValidator.parse(value))
const streamIdentityValidator = (value: unknown): value is StreamIdentity => {
  if (!isRecord(value)) return false
  if (value.runtimeKind !== "main" && value.runtimeKind !== "frontend") return false
  return nonNegativeInteger(value.conversationId) && nonNegativeInteger(value.step) && nonNegativeInteger(value.attempt)
}
const streamEventValidator = defineValidator<StreamEvent>((value) => {
  if (!isRecord(value) || !hasString(value, "type")) throw new RpcValidationError("stream event is invalid")
  if (value.identity !== undefined && !streamIdentityValidator(value.identity)) throw new RpcValidationError("stream event identity is invalid")
  if (value.type === "text" || value.type === "thinking") {
    if (!hasString(value, "text")) throw new RpcValidationError("stream text event is invalid")
  } else if (value.type === "user") {
    if (!hasString(value, "text") || !hasString(value, "source") || !hasString(value, "triggeredAt") || !optionalString(value, "clientId")) throw new RpcValidationError("stream user event is invalid")
  } else if (value.type === "tool") {
    if (!hasString(value, "name") || !isRecord(value.args) || !isJsonValue(value.args) || !hasString(value, "result")) throw new RpcValidationError("stream tool event is invalid")
  } else if (value.type === "usage") {
    for (const field of ["promptTokens", "cachedPromptTokens", "cacheWriteTokens", "completionTokens", "totalTokens", "elapsedMs", "tokensPerSecond"]) {
      if (!optionalNumber(value, field)) throw new RpcValidationError("stream usage event is invalid")
    }
  } else if (value.type === "assistant-start") {
    if (!streamIdentityValidator(value.identity)) throw new RpcValidationError("stream assistant-start event is invalid")
  } else if (value.type === "assistant-end") {
    if (!streamIdentityValidator(value.identity) || (value.outcome !== "committed" && value.outcome !== "abandoned")) throw new RpcValidationError("stream assistant-end event is invalid")
  } else if (value.type === "interrupted") {
    if (!streamIdentityValidator(value.identity)) throw new RpcValidationError("stream interrupted event is invalid")
  } else throw new RpcValidationError("stream event type is invalid")
  return value as StreamEvent
})

const workerEventValidator = defineValidator<WorkerEvent>((value) => {
  if (!isRecord(value) || !hasString(value, "id") || !hasString(value, "agentId") || !finiteNumber(value.seq) || value.seq < 0 ||
      !Number.isInteger(value.seq) || !(value.type === "worker.hello" || value.type === "worker.heartbeat" || value.type === "runner.status" ||
        value.type === "stream.event" || value.type === "metric.recorded" || value.type === "conversation.started" ||
        value.type === "conversation.message" || value.type === "conversation.ended") || !hasString(value, "createdAt") || !isJsonValue(value.payload)) {
    throw new RpcValidationError("worker event is invalid")
  }
  return { id: value.id, agentId: value.agentId, seq: value.seq, type: value.type, createdAt: value.createdAt, payload: value.payload }
})

export const controlAgentsList = defineOperation("control.agents.list", { input: noInput, output: agentRowsValidator, permission: "control.read" })
export const controlAgentStatus = defineOperation("control.agent.status", { input: agentIdInput, output: workerStatusOutput, permission: "control.read" })
export const controlAgentOverview = defineOperation("control.agent.overview", { input: agentIdInput, output: agentOverviewValidator, permission: "control.read" })
export const controlAgentEvents = defineOperation("control.agent.events", {
  input: objectValidator<{ agentId: string; afterSeq?: number; limit?: number; tail?: boolean; view?: string }>("input", (value): value is Record<string, unknown> & { agentId: string; afterSeq?: number; limit?: number; tail?: boolean; view?: string } =>
    hasString(value, "agentId") && value.agentId.length > 0 && optionalSequence(value, "afterSeq") && optionalLimit(value, "limit") &&
    (value.tail === undefined || booleanField(value.tail)) && optionalString(value, "view")),
  output: agentEventsValidator, permission: "control.read",
})
export const controlAgentCompactions = defineOperation("control.agent.compactions", {
  input: objectValidator<{ agentId: string; limit?: number }>("input", (value): value is Record<string, unknown> & { agentId: string; limit?: number } => hasString(value, "agentId") && value.agentId.length > 0 && optionalLimit(value, "limit")),
  output: compactionsPageValidator, permission: "control.read",
})
export const controlEnqueue = defineOperation("control.enqueue", {
  input: objectValidator<{ agentId: string; body: JsonValue }>("input", (value): value is Record<string, unknown> & { agentId: string; body: JsonValue } => hasString(value, "agentId") && "body" in value && isJsonValue(value.body)),
  output: jsonValidator, permission: "control.write",
})
export const controlShutdown = defineOperation("control.shutdown", { input: agentIdInput, output: jsonValidator, permission: "control.write" })
export const controlCron = defineOperation("control.cron", {
  input: objectValidator<{ agentId: string; body?: JsonValue }>("input", (value): value is Record<string, unknown> & { agentId: string; body?: JsonValue } => hasString(value, "agentId") && (value.body === undefined || isJsonValue(value.body))),
  output: jsonValidator, permission: "control.write",
})
export const controlClientConnect = defineOperation("control.client.connect", {
  input: objectValidator<{ agentId: string; body?: JsonValue }>("input", (value): value is Record<string, unknown> & { agentId: string; body?: JsonValue } => hasString(value, "agentId") && (value.body === undefined || isJsonValue(value.body))),
  output: jsonValidator, permission: "control.write",
})
export const controlClientDisconnect = defineOperation("control.client.disconnect", { input: agentIdInput, output: jsonValidator, permission: "control.write" })
export const controlClientStatus = defineOperation("control.client.status", { input: agentIdInput, output: workerClientStatusValidator, permission: "control.read" })
export const controlDiscordChannels = defineOperation("control.discord.channels", { input: agentIdInput, output: controlDiscordChannelsValidator, permission: "control.read" })
export const controlDiscordMessages = defineOperation("control.discord.messages", {
  input: objectValidator<{ agentId: string; channelId: string; before?: string; limit?: number }>("input", (value): value is Record<string, unknown> & { agentId: string; channelId: string; before?: string; limit?: number } =>
    hasString(value, "agentId") && value.agentId.length > 0 && hasString(value, "channelId") && value.channelId.length > 0 && optionalString(value, "before") && optionalLimit(value, "limit")),
  output: controlDiscordMessagesValidator, permission: "control.read",
})
export const controlAgentStream = defineStream("control.agent.stream", {
  input: objectValidator<{ agentId: string; afterSeq?: number }>("input", (value): value is Record<string, unknown> & { agentId: string; afterSeq?: number } => hasString(value, "agentId") && value.agentId.length > 0 && optionalSequence(value, "afterSeq")),
  item: workerEventValidator, permission: "control.read",
  resume: (input, last) => ({ ...input, afterSeq: last.seq }),
})

export type RuntimeKind = "main" | "frontend"

export interface ConversationSubmitInput { event: UserMessage; runtimeKind?: RuntimeKind }
export interface ConversationResult { accepted: boolean; running: boolean }
export interface ConversationHistoryInput { runtimeKind?: RuntimeKind; limit?: number; before?: number }
export interface ConversationHistoryItem { role: string; content: unknown; timestamp?: number; [key: string]: unknown }
export interface ConversationEvent { seq?: number; event: unknown }

const userMessageValid = (value: unknown): value is UserMessage => {
  if (!recordField(value)) return false
  return stringField(value.source) && stringField(value.triggeredAt) && stringField(value.content) && "raw" in value
}
const conversationEventValid = (value: unknown): boolean => recordField(value) && "event" in value && optionalSequence(value, "seq")

export const conversationSubmit = defineOperation("conversation.submit", {
  input: objectValidator<ConversationSubmitInput>("input", (value): value is Record<string, unknown> & ConversationSubmitInput => userMessageValid(value.event) && runtimeKindValid(value.runtimeKind)),
  output: objectValidator<ConversationResult>("output", (value): value is Record<string, unknown> & ConversationResult => booleanField(value.accepted) && booleanField(value.running)),
  permission: "conversation.write",
})
export const conversationHistory = defineOperation("conversation.history", {
  input: objectValidator<ConversationHistoryInput>("input", (value): value is Record<string, unknown> & ConversationHistoryInput => runtimeKindValid(value.runtimeKind) && optionalLimit(value, "limit") && optionalSequence(value, "before")),
  output: defineValidator<readonly ConversationHistoryItem[]>((value) => {
    if (!Array.isArray(value)) throw new RpcValidationError("output must be an array")
    const rows: ConversationHistoryItem[] = []
    for (const row of value) {
      if (!recordField(row) || !stringField(row.role) || !("content" in row)) throw new RpcValidationError("output contains an invalid history item")
      rows.push({ ...row, role: row.role, content: row.content })
    }
    return rows
  }),
  permission: "conversation.read",
})
export const conversationSubscribe = defineStream("conversation.subscribe", {
  input: objectValidator<{ runtimeKind?: RuntimeKind; after?: number; sessionId?: string }>("input", (value): value is Record<string, unknown> & { runtimeKind?: RuntimeKind; after?: number; sessionId?: string } => runtimeKindValid(value.runtimeKind) && optionalSequence(value, "after") && (value.sessionId === undefined || stringField(value.sessionId))),
  item: defineValidator<ConversationEvent>((value) => {
    if (!conversationEventValid(value)) throw new RpcValidationError("item must be a conversation event")
    if (!isRecord(value)) throw new RpcValidationError("item must be a conversation event")
    return { ...("seq" in value && typeof value.seq === "number" ? { seq: value.seq } : {}), event: value.event }
  }),
  permission: "conversation.read",
  resume: (input, last) => ({ ...input, after: last.seq ?? input.after }),
})
export const conversationCancel = defineOperation("conversation.cancel", {
  input: objectValidator<{ runtimeKind?: RuntimeKind; sessionId?: string }>("input", (value): value is Record<string, unknown> & { runtimeKind?: RuntimeKind; sessionId?: string } => runtimeKindValid(value.runtimeKind) && (value.sessionId === undefined || stringField(value.sessionId))),
  output: voidValidator,
  permission: "conversation.write",
})
export interface ModelDescriptor {
  id: string
  name: string
  api: string
  provider: string
  baseUrl: string
  reasoning: boolean
  bridge?: boolean
  effortCapabilities?: { supportedEfforts: string[]; defaultEffort?: string; changeMode: "configuration-update" | "cache-reset" }
  input: ("text" | "image")[]
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number
  maxTokens: number
  headers?: Record<string, string>
}
export interface AssistantContentText { type: "text"; text: string; textSignature?: string }
export type ModelStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_call"; id: string; name: string; arguments: JsonRecord; thoughtSignature?: string }
  | { type: "done"; message: AssistantOutput }
  | { type: "error"; error: string }

export interface WorkerModelReference {
  id: string
  provider: string
  baseUrl: string
}

export interface WorkerModelSnapshot {
  primary: WorkerModelReference | null
  fallback: WorkerModelReference
  respectPromptCache: boolean
  useFallback: boolean
  enableThinking: boolean
  thinkingEffort: string
  vision: boolean
}
export interface AssistantContentThinking { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean }
export interface AssistantContentToolCall { type: "toolCall"; id: string; name: string; arguments: JsonRecord; thoughtSignature?: string }
export interface AssistantUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}
export interface AssistantOutput {
  role: "assistant"
  content: (AssistantContentText | AssistantContentThinking | AssistantContentToolCall)[]
  api: string; provider: string; model: string; responseModel?: string; responseId?: string
  usage: AssistantUsage; stopReason: "stop" | "length" | "toolUse" | "error" | "aborted"
  errorMessage?: string; timestamp: number
}
export interface ToolDefinition { name: string; description?: string; inputSchema: JsonValue }

const modelDescriptorValidator = defineValidator<ModelDescriptor>((value) => {
  if (!recordField(value) || !hasString(value, "id") || !hasString(value, "name") || !hasString(value, "api") || !hasString(value, "provider") || !hasString(value, "baseUrl") || !booleanField(value.reasoning) || !Array.isArray(value.input) || !finiteNumber(value.contextWindow) || !finiteNumber(value.maxTokens)) throw new RpcValidationError("model descriptor is invalid")
  const rawInput = value.input
  const input: ModelDescriptor["input"] = rawInput.map((item: unknown) => {
    if (item === "text" || item === "image") return item
    throw new RpcValidationError("model descriptor is invalid")
  })
  const rawCost = value.cost
  if (!recordField(rawCost) || !finiteNumber(rawCost.input) || !finiteNumber(rawCost.output) || !finiteNumber(rawCost.cacheRead) || !finiteNumber(rawCost.cacheWrite)) throw new RpcValidationError("model descriptor is invalid")
  const cost = { input: rawCost.input, output: rawCost.output, cacheRead: rawCost.cacheRead, cacheWrite: rawCost.cacheWrite }
  if (value.bridge !== undefined && !booleanField(value.bridge)) throw new RpcValidationError("model descriptor is invalid")
  const rawHeaders = value.headers
  let headers: Record<string, string> | undefined
  if (rawHeaders !== undefined) {
    if (!recordField(rawHeaders)) throw new RpcValidationError("model descriptor is invalid")
    headers = {}
    for (const [key, item] of Object.entries(rawHeaders)) {
      if (!stringField(item)) throw new RpcValidationError("model descriptor is invalid")
      headers[key] = item
    }
  }
  let effortCapabilities: ModelDescriptor["effortCapabilities"]
  if (value.effortCapabilities !== undefined) {
    const effort = value.effortCapabilities
    if (!recordField(effort) || !Array.isArray(effort.supportedEfforts) || !effort.supportedEfforts.every(stringField) || !optionalString(effort, "defaultEffort") || (effort.changeMode !== "configuration-update" && effort.changeMode !== "cache-reset")) throw new RpcValidationError("model effort capabilities are invalid")
    const supportedEfforts = effort.supportedEfforts.map((item: unknown) => {
      if (!stringField(item)) throw new RpcValidationError("model effort capabilities are invalid")
      return item
    })
    effortCapabilities = { supportedEfforts, ...(effort.defaultEffort === undefined ? {} : { defaultEffort: stringField(effort.defaultEffort) ? effort.defaultEffort : undefined }), changeMode: effort.changeMode }
  }
  return { id: value.id, name: value.name, api: value.api, provider: value.provider, baseUrl: value.baseUrl, reasoning: value.reasoning, ...(value.bridge === undefined ? {} : { bridge: value.bridge }), ...(effortCapabilities === undefined ? {} : { effortCapabilities }), input, cost, contextWindow: value.contextWindow, maxTokens: value.maxTokens, ...(headers === undefined ? {} : { headers }) }
})
const assistantUsageValidator = (value: unknown): value is AssistantUsage => {
  if (!recordField(value)) return false
  const cost = value.cost
  return ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => finiteNumber(value[key])) && recordField(cost) && ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => finiteNumber(cost[key]))
}
const assistantContentValidator = (value: unknown): value is AssistantOutput["content"][number] => {
  if (!recordField(value)) return false
  if (value.type === "text") return hasString(value, "text") && optionalString(value, "textSignature")
  if (value.type === "thinking") return hasString(value, "thinking") && optionalString(value, "thinkingSignature") && (value.redacted === undefined || booleanField(value.redacted))
  if (value.type === "toolCall") return hasString(value, "id") && hasString(value, "name") && recordField(value.arguments) && isJsonValue(value.arguments) && optionalString(value, "thoughtSignature")
  return false
}
const assistantOutputValidator = defineValidator<AssistantOutput>((value) => {
  if (!recordField(value) || value.role !== "assistant" || !Array.isArray(value.content) || !value.content.every(assistantContentValidator) || !hasString(value, "api") || !hasString(value, "provider") || !hasString(value, "model") || !assistantUsageValidator(value.usage) || !finiteNumber(value.timestamp)) throw new RpcValidationError("assistant output is invalid")
  const stopReason = value.stopReason
  if (stopReason !== "stop" && stopReason !== "length" && stopReason !== "toolUse" && stopReason !== "error" && stopReason !== "aborted") throw new RpcValidationError("assistant output is invalid")
  const responseModel = value.responseModel === undefined ? undefined : stringField(value.responseModel) ? value.responseModel : (() => { throw new RpcValidationError("assistant output is invalid") })()
  const responseId = value.responseId === undefined ? undefined : stringField(value.responseId) ? value.responseId : (() => { throw new RpcValidationError("assistant output is invalid") })()
  const errorMessage = value.errorMessage === undefined ? undefined : stringField(value.errorMessage) ? value.errorMessage : (() => { throw new RpcValidationError("assistant output is invalid") })()
  const content = value.content.map((item) => item.type === "text" ? { type: "text" as const, text: item.text, ...(item.textSignature === undefined ? {} : { textSignature: item.textSignature }) } : item.type === "thinking" ? { type: "thinking" as const, thinking: item.thinking, ...(item.thinkingSignature === undefined ? {} : { thinkingSignature: item.thinkingSignature }), ...(item.redacted === undefined ? {} : { redacted: item.redacted }) } : { type: "toolCall" as const, id: item.id, name: item.name, arguments: item.arguments, ...(item.thoughtSignature === undefined ? {} : { thoughtSignature: item.thoughtSignature }) })
  const usage = value.usage
  return { role: "assistant", content, api: value.api, provider: value.provider, model: value.model, ...(responseModel === undefined ? {} : { responseModel }), ...(responseId === undefined ? {} : { responseId }), usage, stopReason, ...(errorMessage === undefined ? {} : { errorMessage }), timestamp: value.timestamp }
})
const modelStreamEventValidator = defineValidator<ModelStreamEvent>((value) => {
  if (!isRecord(value) || !hasString(value, "type")) throw new RpcValidationError("model stream event is invalid")
  if (value.type === "text_delta" || value.type === "thinking_delta") {
    if (!hasString(value, "delta")) throw new RpcValidationError("model stream delta is invalid")
    return { type: value.type, delta: value.delta }
  }
  if (value.type === "tool_call") {
    if (!hasString(value, "id") || !hasString(value, "name") || !isRecord(value.arguments) || !isJsonValue(value.arguments)) throw new RpcValidationError("model stream tool call is invalid")
    const thoughtSignature = value.thoughtSignature === undefined ? undefined : stringField(value.thoughtSignature) ? value.thoughtSignature : (() => { throw new RpcValidationError("model stream tool call is invalid") })()
    return { type: "tool_call", id: value.id, name: value.name, arguments: value.arguments, ...(thoughtSignature === undefined ? {} : { thoughtSignature }) }
  }
  if (value.type === "done") return { type: "done", message: assistantOutputValidator.parse(value.message) }
  if (value.type === "error" && hasString(value, "error")) return { type: "error", error: value.error }
  throw new RpcValidationError("model stream event type is invalid")
})
const toolDefinitionValidator = defineValidator<ToolDefinition>((value) => {
  if (!recordField(value) || !hasString(value, "name") || !isJsonValue(value.inputSchema)) throw new RpcValidationError("tool definition is invalid")
  let description: string | undefined
  if (value.description !== undefined) {
    if (!stringField(value.description)) throw new RpcValidationError("tool definition is invalid")
    description = value.description
  }
  return { name: value.name, ...(description === undefined ? {} : { description }), inputSchema: value.inputSchema }
})
const toolDefinitionsValidator = defineValidator<readonly ToolDefinition[]>((value) => {
  if (!Array.isArray(value)) throw new RpcValidationError("tool definitions must be an array")
  return value.map((tool) => toolDefinitionValidator.parse(tool))
})

export const modelList = defineOperation("model.list", { input: noInput, output: defineValidator<readonly ModelDescriptor[]>((value) => {
  if (!Array.isArray(value)) throw new RpcValidationError("model list output must be an array")
  for (const model of value) modelDescriptorValidator.parse(model)
  return value
}), permission: "model.read" })
export const modelComplete = defineOperation("model.complete", {
  input: objectValidator<{ model: ModelDescriptor; context: JsonValue; options?: JsonValue }>("input", (value) =>
    modelDescriptorValidator.parse(value.model) !== undefined && isJsonValue(value.context) && (value.options === undefined || isJsonValue(value.options))),
  output: assistantOutputValidator, permission: "model.complete",
})
export const modelStream = defineStream("model.stream", {
  input: objectValidator<{ model: ModelDescriptor; context: JsonValue; options?: JsonValue }>("input", (value) =>
    modelDescriptorValidator.parse(value.model) !== undefined && isJsonValue(value.context) && (value.options === undefined || isJsonValue(value.options))),
  item: modelStreamEventValidator, permission: "model.stream",
})
export const toolsList = defineOperation("tools.list", { input: objectValidator<{ runtimeKind?: RuntimeKind }>("input", (value) => runtimeKindValid(value.runtimeKind)), output: toolDefinitionsValidator, permission: "tools.read" })
export const workerStatus = defineOperation("worker.status", { input: noInput, output: workerStatusOutput, permission: "worker.read" })
export const workerEventsList = defineOperation("worker.events.list", {
  input: objectValidator<{ afterSeq?: number; limit?: number; tail?: boolean }>("input", (value) => optionalSequence(value, "afterSeq") && optionalLimit(value, "limit") && (value.tail === undefined || booleanField(value.tail))),
  output: workerEventArrayValidator, permission: "worker.read",
})
export const workerEvents = defineStream("worker.events", {
  input: objectValidator<{ afterSeq?: number; limit?: number }>("input", (value) => optionalSequence(value, "afterSeq") && optionalLimit(value, "limit")),
  item: defineValidator<ReplayStreamItem<WorkerEvent> | ReplayStreamGap>((value) => {
    if (!isRecord(value)) throw new RpcValidationError("worker stream item must be an object")
    if ("after" in value) {
      if (!finiteNumber(value.after) || value.after < 0 || !Number.isInteger(value.after) || !finiteNumber(value.availableFrom) ||
          !finiteNumber(value.latest) || value.availableFrom < 0 || value.latest < 0 || !Number.isInteger(value.availableFrom) || !Number.isInteger(value.latest)) {
        throw new RpcValidationError("worker stream gap is invalid")
      }
      return value as unknown as ReplayStreamGap
    }
    if (!finiteNumber(value.seq) || value.seq < 0 || !Number.isInteger(value.seq) || typeof value.volatile !== "boolean") {
      throw new RpcValidationError("worker stream item is invalid")
    }
    if ((value.seq === 0) !== value.volatile) throw new RpcValidationError("worker stream sequence and volatility disagree")
    workerEventValidator.parse(value.value)
    return value as unknown as ReplayStreamItem<WorkerEvent>
  }),
  permission: "worker.read",
  resume: (input, last) => ({ ...input, afterSeq: "after" in last ? last.latest : last.seq }),
})

export interface WorkerChatSubmitInput { content: string; clientId?: string }
export const workerChatSubmit = defineOperation("worker.chat.submit", {
  input: objectValidator<WorkerChatSubmitInput>("input", (value) => stringField(value.content) && (value.clientId === undefined || stringField(value.clientId))),
  output: objectValidator<{ ok: true; running: boolean }>("output", (value) => value.ok === true && booleanField(value.running)),
  permission: "conversation.write",
})
export const workerChatStream = defineStream("worker.chat.stream", {
  input: objectValidator<Record<string, never>>("input", (value) => Object.keys(value).length === 0),
  item: streamEventValidator, permission: "conversation.read",
})

export interface WorkerTriggerInput { body: JsonValue }
export interface WorkerModelSwapInput { preset: string }
export type MetricListType = "response" | "summarization" | "memory" | "usage" | "discord"
export type MetricBucketName = "memories" | "summarization" | "response" | "usage" | "discord"
export interface MetricUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}
export interface WorkerMetricQuery {
  limit?: number
  cursor?: number
  cursors?: Partial<Record<MetricBucketName, string | number>>
  type?: MetricListType[]
  includeRaw?: boolean
  q?: string
  from?: string
  to?: string
}
export interface WorkerOperationResult {
  ok: boolean
  agentId?: string
  running?: boolean
  notified?: boolean
  [key: string]: JsonValue | undefined
}

export interface WorkerMetricBase {
  id: number
  timestamp: string
  sourceType: "prompt_response" | "compaction" | "memory" | "usage"
  detailPath: string
}
export type WorkerMetricListItem =
  | (WorkerMetricBase & { type: "response"; sourceType: "prompt_response"; promptMetricId?: number; model?: string; toolChoice?: string; messageCount?: number; lastUserMessage?: string; responsePreview?: string; toolCallCount?: number; usage?: MetricUsage })
  | (WorkerMetricBase & { type: "summarization"; sourceType: "compaction"; method?: string; before?: number; after?: number; savedTokens?: number; summaryPreview?: string; summaryChars?: number })
  | (WorkerMetricBase & { type: "memory"; sourceType: "memory"; queryPreview?: string; resultCount?: number })
  | (WorkerMetricBase & { type: "usage"; sourceType: "usage"; usage?: MetricUsage })
export interface WorkerDiscordMetricListItem {
  id: string
  type: "discord"
  sourceType: "discord"
  timestamp: string
  detailPath: string
  messageId: string
  channelId: string
  guildId?: string
  authorId?: string
  authorUsername?: string
  contentPreview?: string
  isDm: boolean
  mentionsBot: boolean
  isFromBot: boolean
}
export interface WorkerMetricsPage {
  memories: WorkerMetricListItem[]
  summarization: WorkerMetricListItem[]
  response: WorkerMetricListItem[]
  usage: WorkerMetricListItem[]
  discord: WorkerDiscordMetricListItem[]
  limit: number
  nextCursor: Partial<Record<MetricBucketName, string | number>>
  hasMore: Partial<Record<MetricBucketName, boolean>>
  filters: { type?: MetricListType[]; includeRaw: boolean; q?: string; from?: string; to?: string }
}
const metricUsageValid = (value: unknown): value is MetricUsage => {
  if (!isRecord(value) || !["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => finiteNumber(value[key]))) return false
  const cost = value.cost
  return isRecord(cost) && ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => finiteNumber(cost[key]))
}
const metricListItemValid = (value: unknown): value is WorkerMetricListItem => {
  if (!isRecord(value) || !finiteNumber(value.id) || !hasString(value, "timestamp") || !hasString(value, "detailPath")) return false
  const optionalNumberFields = (fields: readonly string[]) => fields.every((field) => optionalNumber(value, field))
  const optionalStringFields = (fields: readonly string[]) => fields.every((field) => optionalString(value, field))
  if (value.type === "response" && value.sourceType === "prompt_response") {
    return optionalNumberFields(["promptMetricId", "messageCount", "toolCallCount"]) &&
      optionalStringFields(["model", "toolChoice", "lastUserMessage", "responsePreview"]) &&
      (value.usage === undefined || metricUsageValid(value.usage))
  }
  if (value.type === "summarization" && value.sourceType === "compaction") {
    return optionalNumberFields(["before", "after", "savedTokens", "summaryChars"]) &&
      optionalStringFields(["method", "summaryPreview"])
  }
  if (value.type === "memory" && value.sourceType === "memory") {
    return optionalNumberFields(["resultCount"]) && optionalStringFields(["queryPreview"])
  }
  return value.type === "usage" && value.sourceType === "usage" && (value.usage === undefined || metricUsageValid(value.usage))
}
const discordMetricListItemValid = (value: unknown): value is WorkerDiscordMetricListItem => isRecord(value) &&
  typeof value.id === "string" && value.type === "discord" && value.sourceType === "discord" &&
  hasString(value, "timestamp") && hasString(value, "detailPath") && hasString(value, "messageId") &&
  hasString(value, "channelId") && optionalString(value, "guildId") && optionalString(value, "authorId") &&
  optionalString(value, "authorUsername") && optionalString(value, "contentPreview") &&
  booleanField(value.isDm) && booleanField(value.mentionsBot) && booleanField(value.isFromBot)
const metricCursorValid = (value: unknown): value is WorkerMetricsPage["nextCursor"] =>
  isRecord(value) && Object.entries(value).every(([key, item]) =>
    (key === "memories" || key === "summarization" || key === "response" || key === "usage" || key === "discord") &&
    (typeof item === "string" || finiteNumber(item)))
const metricHasMoreValid = (value: unknown): value is WorkerMetricsPage["hasMore"] =>
  isRecord(value) && Object.entries(value).every(([key, item]) =>
    (key === "memories" || key === "summarization" || key === "response" || key === "usage" || key === "discord") && booleanField(item))
const metricsQueryValidator = objectValidator<WorkerMetricQuery>("input", (value) =>
  optionalNumber(value, "limit") && optionalNumber(value, "cursor") &&
  (value.type === undefined || Array.isArray(value.type) && value.type.every((item) => item === "response" || item === "summarization" || item === "memory" || item === "usage" || item === "discord")) &&
  (value.includeRaw === undefined || booleanField(value.includeRaw)) && optionalString(value, "q") && optionalString(value, "from") && optionalString(value, "to") &&
  (value.cursors === undefined || isRecord(value.cursors) && Object.entries(value.cursors).every(([key, item]) => (key === "memories" || key === "summarization" || key === "response" || key === "usage" || key === "discord") && (typeof item === "string" || finiteNumber(item)))))
const metricsPageValidator = defineValidator<WorkerMetricsPage>((value) => {
  if (!isRecord(value) || !finiteNumber(value.limit) || !metricCursorValid(value.nextCursor) || !metricHasMoreValid(value.hasMore) || !isRecord(value.filters) || !booleanField(value.filters.includeRaw) || !optionalString(value.filters, "q") || !optionalString(value.filters, "from") || !optionalString(value.filters, "to")) throw new RpcValidationError("metrics page is invalid")
  if (!Array.isArray(value.memories) || !value.memories.every((item) => metricListItemValid(item) && item.type === "memory" && item.sourceType === "memory")) throw new RpcValidationError("metrics memories bucket is invalid")
  if (!Array.isArray(value.summarization) || !value.summarization.every((item) => metricListItemValid(item) && item.type === "summarization" && item.sourceType === "compaction")) throw new RpcValidationError("metrics summarization bucket is invalid")
  if (!Array.isArray(value.response) || !value.response.every((item) => metricListItemValid(item) && item.type === "response" && item.sourceType === "prompt_response")) throw new RpcValidationError("metrics response bucket is invalid")
  if (!Array.isArray(value.usage) || !value.usage.every((item) => metricListItemValid(item) && item.type === "usage" && item.sourceType === "usage")) throw new RpcValidationError("metrics usage bucket is invalid")
  if (!Array.isArray(value.discord) || !value.discord.every(discordMetricListItemValid)) throw new RpcValidationError("metrics discord bucket is invalid")
  return { memories: value.memories as WorkerMetricListItem[], summarization: value.summarization as WorkerMetricListItem[], response: value.response as WorkerMetricListItem[], usage: value.usage as WorkerMetricListItem[], discord: value.discord, limit: value.limit, nextCursor: value.nextCursor, hasMore: value.hasMore, filters: value.filters as WorkerMetricsPage["filters"] }
})

const triggerInputValidator = objectValidator<WorkerTriggerInput>("input", (value) => "body" in value && isJsonValue(value.body))
const operationResultValidator = defineValidator<WorkerOperationResult>((value) => {
  if (!isRecord(value) || !isJsonValue(value) || typeof value.ok !== "boolean" || (value.agentId !== undefined && !stringField(value.agentId)) || (value.running !== undefined && !booleanField(value.running)) || (value.notified !== undefined && !booleanField(value.notified))) throw new RpcValidationError("operation result is invalid")
  return { ...value, ok: value.ok, ...(value.agentId === undefined ? {} : { agentId: value.agentId }), ...(value.running === undefined ? {} : { running: value.running }), ...(value.notified === undefined ? {} : { notified: value.notified }) }
})
const workerModelSnapshotValidator = objectValidator<WorkerModelSnapshot>("model snapshot", (value) =>
  (value.primary === null || modelRefValid(value.primary)) && modelRefValid(value.fallback) &&
  booleanField(value.respectPromptCache) && booleanField(value.useFallback) && booleanField(value.enableThinking) &&
  hasString(value, "thinkingEffort") && booleanField(value.vision))
const modelRefValid = (value: unknown): boolean => isRecord(value) && hasString(value, "id") && hasString(value, "provider") && hasString(value, "baseUrl")
export const workerModelGet = defineOperation("worker.model.get", { input: noInput, output: workerModelSnapshotValidator, permission: "worker.read" })
export const workerModelSwap = defineOperation("worker.model.swap", {
  input: objectValidator<WorkerModelSwapInput>("input", (value) => hasString(value, "preset") && value.preset.trim().length > 0),
  output: operationResultValidator, permission: "worker.write",
})
export const workerTriggerDiscord = defineOperation("worker.trigger.discord", { input: triggerInputValidator, output: operationResultValidator, permission: "worker.write" })
export const workerTriggerBsky = defineOperation("worker.trigger.bsky", { input: triggerInputValidator, output: operationResultValidator, permission: "worker.write" })
export const workerTriggerWebhook = defineOperation("worker.trigger.webhook", { input: triggerInputValidator, output: operationResultValidator, permission: "worker.write" })
export const workerTriggerCron = defineOperation("worker.trigger.cron", { input: triggerInputValidator, output: operationResultValidator, permission: "worker.write" })
export const workerTriggerChat = defineOperation("worker.trigger.chat", { input: triggerInputValidator, output: operationResultValidator, permission: "conversation.write" })
export const workerClientStatus = defineOperation("worker.client.status", { input: noInput, output: workerClientStatusValidator, permission: "worker.read" })
export const workerClientConnect = defineOperation("worker.client.connect", {
  input: objectValidator<{ endpoint: string; workspace?: JsonValue; capabilities?: string[] }>("input", (value) =>
    hasString(value, "endpoint") && value.endpoint.trim().length > 0 && (value.workspace === undefined || isJsonValue(value.workspace)) &&
    (value.capabilities === undefined || Array.isArray(value.capabilities) && value.capabilities.every(stringField))),
  output: operationResultValidator, permission: "worker.write",
})
export const workerClientDisconnect = defineOperation("worker.client.disconnect", { input: noInput, output: operationResultValidator, permission: "worker.write" })
export const workerDiscordChannels = defineOperation("worker.discord.channels", { input: noInput, output: defineValidator<DiscordChannel[]>((value) => {
  if (!Array.isArray(value) || !value.every(discordChannelValidator)) throw new RpcValidationError("Discord channels are invalid")
  return value
}), permission: "discord.read" })
export const workerDiscordMessages = defineOperation("worker.discord.messages", {
  input: objectValidator<{ channelId: string; before?: string; limit?: number }>("input", (value) => hasString(value, "channelId") && value.channelId.length > 0 && optionalString(value, "before") && optionalLimit(value, "limit")),
  output: defineValidator<DiscordMessage[]>((value) => {
    if (!Array.isArray(value) || !value.every(discordMessageValidator)) throw new RpcValidationError("Discord messages are invalid")
    return value
  }), permission: "discord.read",
})
export const workerDiscordIngress = defineOperation("worker.discord.ingress", { input: triggerInputValidator, output: operationResultValidator, permission: "discord.write" })
export const workerMetricsList = defineOperation("worker.metrics.list", { input: metricsQueryValidator, output: metricsPageValidator, permission: "metrics.read" })
export const workerMetricsDetail = defineOperation("worker.metrics.detail", { input: objectValidator<{ id: number }>("input", (value) => finiteNumber(value.id)), output: jsonValidator, permission: "metrics.read" })
export const workerDiscordMetricDetail = defineOperation("worker.metrics.discord", { input: objectValidator<{ id: string }>("input", (value) => hasString(value, "id")), output: jsonValidator, permission: "metrics.read" })
export const workerControlShutdown = defineOperation("worker.control.shutdown", { input: noInput, output: operationResultValidator, permission: "worker.write" })
export const workerControlRestart = defineOperation("worker.control.restart", { input: objectValidator<{ reason?: string }>("input", (value) => optionalString(value, "reason")), output: operationResultValidator, permission: "worker.write" })
export const workerAwpEnqueue = defineOperation("worker.awp.enqueue", {
  input: objectValidator<{ event: UserMessage; options?: { onlyIfWaiting?: boolean; priority?: boolean } }>("input", (value) =>
    userMessageValid(value.event) && (value.options === undefined || isRecord(value.options) &&
      (value.options.onlyIfWaiting === undefined || booleanField(value.options.onlyIfWaiting)) &&
      (value.options.priority === undefined || booleanField(value.options.priority)))),
  output: operationResultValidator, permission: "conversation.write",
})
