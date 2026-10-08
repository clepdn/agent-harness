import { defineService } from "@nano/plugins"
import type { AgentRecord, AgentEventsPage, AgentOverview, CompactionsPage, ControlAgentsList, DiscordChannels, DiscordMessages, JsonValue, WorkerClientStatus, WorkerEvent, WorkerStatusSnapshot } from "@nano/protocol"
import type { FastifyInstance, FastifyReply } from "fastify"

export type { AgentRecord, AgentEventsPage, AgentOverview, CompactionsPage, ControlAgentsList, DiscordChannels, DiscordMessages, JsonValue, WorkerClientStatus, WorkerEvent, WorkerStatusSnapshot }

export type AgentFile = {
  id?: string
  name?: string
  port?: number
  home?: string
  client?: string
  workspace?: string
  config?: string[]
  secrets?: string
  settings?: Record<string, string | number | boolean>
}

export type ResolvedLocalAgent = {
  id: string
  name: string
  port: number
  home: string
  client: string
  workspace?: string
  config: string[]
  secrets?: string
  settings: Record<string, string>
  source: string
}

export type MirroredCompaction = {
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

export type ControlStore = {
  initialize(): void
  close(): void
  upsertAgent(input: { id: string; name?: string; baseUrl: string }): AgentRecord
  listAgents(): AgentRecord[]
  getAgent(id: string): AgentRecord | null
  updateAgentStatus(id: string, status: string, lastSeq?: number): void
  recordWorkerEvent(event: WorkerEvent): void
  listMirroredEvents(agentId: string, afterSeq?: number, limit?: number, mode?: "after" | "tail"): unknown[]
  listRecentCompactions(agentId: string, limit?: number): MirroredCompaction[]
}

export type ControlAgentRegistry = {
  readonly configuredAgentIds: ReadonlySet<string>
  stopLocalAgent(id: string): Promise<boolean>
}

export type OperationContext = { signal: AbortSignal; subject: string }

export type ControlOperations = {
  listAgents(): ControlAgentsList
  status(input: { agentId: string }, context: OperationContext): Promise<WorkerStatusSnapshot>
  overview(input: { agentId: string }, context: OperationContext): Promise<AgentOverview>
  events(input: { agentId: string; afterSeq?: number; limit?: number; tail?: boolean; view?: string }, context: OperationContext): Promise<AgentEventsPage>
  compactions(input: { agentId: string; limit?: number }): CompactionsPage
  enqueue(input: { agentId: string; body: JsonValue }, context: OperationContext): Promise<JsonValue>
  shutdown(input: { agentId: string }, context: OperationContext): Promise<JsonValue>
  cron(input: { agentId: string; body?: JsonValue }, context: OperationContext): Promise<JsonValue>
  clientConnect(input: { agentId: string; body?: JsonValue }, context: OperationContext): Promise<JsonValue>
  clientDisconnect(input: { agentId: string }, context: OperationContext): Promise<JsonValue>
  clientStatus(input: { agentId: string }, context: OperationContext): Promise<WorkerClientStatus>
  discordChannels(input: { agentId: string }, context: OperationContext): Promise<DiscordChannels>
  discordMessages(input: { agentId: string; channelId: string; before?: string; limit?: number }, context: OperationContext): Promise<DiscordMessages>
  stream(input: { agentId: string; afterSeq?: number }, context: OperationContext): AsyncIterable<WorkerEvent>
}

export type ControlStaticUi = {
  readonly enabled: boolean
  readonly directory: string
  serve(relativePath: string | undefined, reply: FastifyReply): Promise<unknown>
}

export const CONTROL_STORE = defineService<ControlStore>("control.store")
export const CONTROL_AGENTS = defineService<ControlAgentRegistry>("control.agents")
export const CONTROL_OPERATIONS = defineService<ControlOperations>("control.operations")
export const CONTROL_LOCAL_AGENTS = defineService<readonly ResolvedLocalAgent[]>("control.local-agents")
export const CONTROL_STATIC_UI = defineService<ControlStaticUi>("control.static-ui")
export const CONTROL_HTTP = defineService<FastifyInstance>("control.http")
