import {
  controlAgentCompactions,
  controlAgentEvents,
  controlAgentOverview,
  controlAgentStatus,
  controlAgentStream,
  controlAgentsList,
  controlClientConnect,
  controlClientDisconnect,
  controlClientStatus,
  controlCron,
  controlDiscordChannels,
  controlDiscordMessages,
  controlEnqueue,
  controlShutdown,
  type AgentEventsPage,
  type AgentOverview,
  type AgentRecord,
  type CompactionsPage,
  type ControlAgentsList,
  type DiscordChannels,
  type DiscordMessages,
  type JsonValue,
  type WorkerClientStatus,
  type WorkerEvent,
  type WorkerStatusSnapshot,
} from "@nano/protocol"
import {
  nanoRpcAuth,
  parseRpcAuthConfig,
  registerOperation,
  registerStream,
  type RpcAuthConfig,
  type RpcAuthService,
} from "@nano/protocol/rpc"
import { defineService, type Plugin } from "@nano/plugins"
import { ControlStore, type WorkerEventRecord } from "./db"
import { LocalAgentSupervisor } from "../supervisor"
import { assertNoDuplicateBridgePorts, assertNoDuplicateDiscordTokens, buildWorkerEnvironment, loadAgentFiles, resolveLocalAgents, type ResolvedLocalAgent } from "../local-agents"

export type ControlAgentRegistry = {
  readonly configuredAgentIds: ReadonlySet<string>
  stopLocalAgent(id: string): Promise<boolean>
}

export type OperationContext = { signal: AbortSignal; subject: string }
type WorkerAgent = Pick<AgentRecord, "id" | "name" | "baseUrl" | "lastSeq">

export const CONTROL_STORE = defineService<ControlStore>("control.store")
export const CONTROL_AGENTS = defineService<ControlAgentRegistry>("control.agents")
export const CONTROL_OPERATIONS = defineService<ControlOperations>("control.operations")
export const CONTROL_LOCAL_AGENTS = defineService<readonly ResolvedLocalAgent[]>("control.local-agents")

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

export function controlDiscoveryPlugin(options: { directory: string; controlPort: number; repoRoot: string; allowEmpty?: boolean }): Plugin {
  return {
    id: "control.discovery",
    requires: [CONTROL_STORE],
    provides: [CONTROL_LOCAL_AGENTS],
    apply(scope) {
      let agents: ResolvedLocalAgent[]
      try {
        agents = resolveLocalAgents(loadAgentFiles(options.directory), options)
      } catch (error) {
        if (!options.allowEmpty || !(error instanceof Error) || !/agent directory does not exist|no agent JSON files found/.test(error.message)) throw error
        agents = []
      }
      assertNoDuplicateDiscordTokens(agents)
      assertNoDuplicateBridgePorts(agents, options.controlPort)
      scope.provide(CONTROL_LOCAL_AGENTS, agents)
    },
  }
}

export function controlSupervisorPlugin(options: { repoRoot: string; workerEntry: string }): Plugin {
  return {
    id: "control.supervisor",
    requires: [CONTROL_STORE, CONTROL_LOCAL_AGENTS],
    provides: [CONTROL_AGENTS],
    async apply(scope) {
      const store = scope.use(CONTROL_STORE)
      const localAgents = scope.use(CONTROL_LOCAL_AGENTS)
      const supervisors = new Map<string, LocalAgentSupervisor>()
      const configuredAgentIds = new Set(localAgents.map((agent) => agent.id))
      for (const agent of localAgents) {
        supervisors.set(agent.id, new LocalAgentSupervisor({
          agent,
          repoRoot: options.repoRoot,
          workerEntry: options.workerEntry,
          workerEnv: buildWorkerEnvironment(process.env, agent),
          signal: scope.signal,
          onReady: (readyAgent) => store.upsertAgent({ id: readyAgent.id, name: readyAgent.name, baseUrl: `http://127.0.0.1:${readyAgent.port}` }),
        }))
      }
      scope.provide(CONTROL_AGENTS, {
        configuredAgentIds,
        async stopLocalAgent(id) {
          const supervisor = supervisors.get(id)
          if (!supervisor) return false
          await supervisor.stop()
          return true
        },
      })
      scope.own(async () => {
        await Promise.all([...supervisors.values()].map((supervisor) => supervisor.stop()))
      })
      await Promise.all([...supervisors.values()].map((supervisor) => supervisor.start()))
    },
  }
}

export function controlRpcAuthPlugin(): Plugin<RpcAuthConfig> {
  return {
    id: "nano.rpc-auth",
    provides: [nanoRpcAuth],
    validate: parseRpcAuthConfig,
    apply(scope, value) {
      const auth: RpcAuthService = {
        mode: value.mode,
        ...(value.token ? { token: value.token } : {}),
        allowedOrigins: value.allowedOrigins ?? [],
        permissions: value.permissions ?? [],
      }
      scope.provide(nanoRpcAuth, auth)
    },
  }
}


export function controlStorePlugin(store: ControlStore): Plugin {
  return {
    id: "control.persistence",
    provides: [CONTROL_STORE],
    apply(scope) {
      store.initialize()
      scope.provide(CONTROL_STORE, store)
      scope.own(() => store.close())
    },
  }
}
function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function fetchWorkerJson<T = unknown>(agent: WorkerAgent, path: string, context: OperationContext, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json")
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15_000)])
  const response = await fetch(`${agent.baseUrl}${path}`, { ...init, headers, signal })
  const text = await response.text()
  const data = parseJsonOrText(text)
  if (!response.ok) {
    const detail = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : text
    throw new Error(detail || `${response.status} ${response.statusText}`)
  }
  return data as T
}

function isWorkerEvent(value: unknown): value is WorkerEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const event = value as Partial<WorkerEvent>
  return typeof event.id === "string" && typeof event.agentId === "string" && typeof event.seq === "number" &&
    typeof event.type === "string" && typeof event.createdAt === "string"
}

function mirrorWorkerEvent(store: ControlStore, raw: unknown, agentId?: string): void {
  if (!isWorkerEvent(raw)) return
  const event = !agentId || raw.agentId === agentId ? raw : { ...raw, agentId }
  store.recordWorkerEvent(event as WorkerEventRecord)
}

function mirrorWorkerEvents(store: ControlStore, raw: unknown, agentId?: string): void {
  if (!raw || typeof raw !== "object" || !("events" in raw)) return
  const events = (raw as { events?: unknown }).events
  if (Array.isArray(events)) for (const event of events) mirrorWorkerEvent(store, event, agentId)
}

function chatEventFromBody(agentId: string, body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  const input = body as Record<string, unknown>
  const content = typeof input.content === "string" ? input.content.trim() : ""
  if (!content) return null
  return {
    source: "chat",
    triggeredAt: new Date().toISOString(),
    content,
    raw: body,
    clientId: typeof input.clientId === "string" ? input.clientId : `control-${agentId}`,
  }
}

function compactText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trimEnd()}\n\n... truncated for the control panel ...`
}

export function compactWorkerEventForChat(raw: unknown): WorkerEvent | null {
  if (!isWorkerEvent(raw)) return null
  const payload = raw.payload && typeof raw.payload === "object" ? raw.payload as Record<string, unknown> : {}
  if (raw.type === "conversation.started" || raw.type === "conversation.ended") return raw
  if (raw.type === "stream.event") {
    const type = typeof payload.type === "string" ? payload.type : ""
    if (type !== "user") return null
    return { ...raw, payload: {
      type,
      ...(payload.source === undefined ? {} : { source: payload.source }),
      ...(payload.text === undefined ? {} : { text: payload.text }),
      ...(payload.triggeredAt === undefined ? {} : { triggeredAt: payload.triggeredAt }),
      ...(payload.clientId === undefined ? {} : { clientId: payload.clientId }),
    } }
  }
  if (raw.type !== "conversation.message") return null
  const role = typeof payload.role === "string" ? payload.role : ""
  const content = typeof payload.content === "string" ? payload.content : ""
  const toolCalls = role === "assistant" && Array.isArray(payload.toolCalls) ? payload.toolCalls : []
  if (!content.trim() && toolCalls.length === 0) return null
  if (role === "user" && (content.trim().startsWith("[wake]") || content.trim().startsWith("[incoming"))) return null
  if (role !== "assistant" && role !== "tool" && role !== "toolResult" && role !== "user") return null
  const isToolResult = role === "tool" || role === "toolResult"
  return {
    ...raw,
    payload: {
      role,
      content: isToolResult ? compactText(content, 2400) : content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(isToolResult && typeof payload.toolCallId === "string" ? { toolCallId: payload.toolCallId } : {}),
      createdAt: payload.createdAt,
    },
  }
}

export function compactEventsForChat(events: unknown[]): WorkerEvent[] {
  const result: WorkerEvent[] = []
  for (const event of events) {
    const compact = compactWorkerEventForChat(event)
    if (compact) result.push(compact)
  }
  return result
}

function splitSseBlocks(buffer: string): { blocks: string[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, "\n").split("\n\n")
  return { blocks: parts.slice(0, -1), rest: parts.at(-1) ?? "" }
}

async function* workerEventStream(store: ControlStore, agent: WorkerAgent, agentId: string, afterSeq: number, context: OperationContext): AsyncIterable<WorkerEvent> {
  const response = await fetch(`${agent.baseUrl}/awp/stream?after_seq=${afterSeq}`, {
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(24 * 60 * 60 * 1000)]),
  })
  if (!response.ok || !response.body) throw new Error(`${response.status} ${response.statusText}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (!context.signal.aborted) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      const parsed = splitSseBlocks(buffer)
      buffer = parsed.rest
      for (const block of parsed.blocks) {
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart())
        if (!data.length) continue
        try {
          const event: unknown = JSON.parse(data.join("\n"))
          if (!isWorkerEvent(event)) continue
          mirrorWorkerEvent(store, event, agentId)
          yield event.agentId === agentId ? event : { ...event, agentId }
        } catch {}
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function controlOperationsPlugin(): Plugin {
  return {
    id: "control.operations",
    requires: [CONTROL_STORE, CONTROL_AGENTS],
    provides: [CONTROL_OPERATIONS],
    apply(scope) {
      const store = scope.use(CONTROL_STORE)
      const registry = scope.use(CONTROL_AGENTS)
      const findAgent = (id: string): AgentRecord | null => registry.configuredAgentIds.has(id) ? store.getAgent(id) : null
      const requireAgent = (id: string): AgentRecord => {
        const agent = findAgent(id)
        if (!agent) throw new Error("agent not found")
        return agent
      }
      const markOffline = (id: string) => store.updateAgentStatus(id, "offline")
      const callWorker = async <T>(id: string, path: string, context: OperationContext, init?: RequestInit): Promise<T> => {
        try {
          const value = await fetchWorkerJson<T>(requireAgent(id), path, context, init)
          store.updateAgentStatus(id, "online")
          return value
        } catch (error) {
          markOffline(id)
          throw error
        }
      }
      const operations: ControlOperations = {
        listAgents: () => ({ agents: store.listAgents().filter((agent) => registry.configuredAgentIds.has(agent.id)) }),
        async status({ agentId }, context) { return callWorker<WorkerStatusSnapshot>(agentId, "/awp/status", context) },
        async overview({ agentId }, context): Promise<AgentOverview> {
          const agent = requireAgent(agentId)
          let status: WorkerStatusSnapshot | { error: string } | null = null
          try {
            status = await fetchWorkerJson<WorkerStatusSnapshot>(agent, "/awp/status", context)
            store.updateAgentStatus(agentId, "online")
          } catch (error) {
            markOffline(agentId)
            status = { error: error instanceof Error ? error.message : String(error) }
          }
          return { agent: findAgent(agentId) ?? agent, status, compactions: store.listRecentCompactions(agentId, 12) }
        },
        async enqueue({ agentId, body }, context): Promise<JsonValue> {
          const agent = requireAgent(agentId)
          const request = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {}
          let command: unknown
          if (request.type === "event.enqueue") command = body
          else {
            const event = chatEventFromBody(agentId, body)
            if (!event) throw new Error("expected content or event.enqueue command")
            command = { type: "event.enqueue", event }
          }
          const previousLastSeq = agent.lastSeq
          try {
            const result = await fetchWorkerJson<JsonValue>(agent, "/awp/events", context, { method: "POST", body: JSON.stringify(command) })
            try {
              const remote = await fetchWorkerJson<unknown>(agent, `/awp/events?after_seq=${previousLastSeq}&limit=1000`, context)
              mirrorWorkerEvents(store, remote, agentId)
            } catch (error) {
              console.warn(`[control] failed to sync events from ${agentId}: ${error instanceof Error ? error.message : String(error)}`)
            }
            store.updateAgentStatus(agentId, "online")
            return result
          } catch (error) {
            markOffline(agentId)
            throw error
          }
        },
        async shutdown({ agentId }, context): Promise<JsonValue> {
          requireAgent(agentId)
          if (await registry.stopLocalAgent(agentId)) {
            markOffline(agentId)
            return { ok: true, agentId, shuttingDown: true }
          }
          return callWorker<JsonValue>(agentId, "/awp/shutdown", context, { method: "POST" })
        },
        cron: ({ agentId, body }, context) => callWorker<JsonValue>(agentId, "/trigger/cron", context, { method: "POST", body: JSON.stringify(body ?? {}) }),
        clientConnect: ({ agentId, body }, context) => callWorker<JsonValue>(agentId, "/client/connect", context, { method: "POST", body: JSON.stringify(body ?? {}) }),
        clientDisconnect: ({ agentId }, context) => callWorker<JsonValue>(agentId, "/client/disconnect", context, { method: "POST" }),
        clientStatus: ({ agentId }, context) => callWorker<WorkerClientStatus>(agentId, "/awp/client/status", context),
        discordChannels: ({ agentId }, context) => callWorker<DiscordChannels>(agentId, "/discord/channels", context),
        async discordMessages({ agentId, channelId, before, limit }, context) {
          const params = new URLSearchParams()
          if (before) params.set("before", before)
          if (limit !== undefined) params.set("limit", String(limit))
          return callWorker<DiscordMessages>(agentId, `/discord/channels/${encodeURIComponent(channelId)}/messages?${params}`, context)
        },
        async events({ agentId, afterSeq = 0, limit = 500, tail = false, view }, context): Promise<AgentEventsPage> {
          const agent = requireAgent(agentId)
          const mode = tail ? "tail" : "after"
          try {
            const remote = await fetchWorkerJson<unknown>(agent, mode === "tail" ? `/awp/events?tail=1&limit=${limit}` : `/awp/events?after_seq=${afterSeq}&limit=${limit}`, context)
            mirrorWorkerEvents(store, remote, agentId)
            store.updateAgentStatus(agentId, "online")
          } catch (error) {
            markOffline(agentId)
            console.warn(`[control] failed to sync events from ${agentId}: ${error instanceof Error ? error.message : String(error)}`)
          }
          const events = store.listMirroredEvents(agentId, afterSeq, limit, mode) as WorkerEvent[]
          return { agentId, events: view === "chat" ? compactEventsForChat(events) : events }
        },
        compactions: ({ agentId, limit = 20 }): CompactionsPage => {
          requireAgent(agentId)
          return { agentId, compactions: store.listRecentCompactions(agentId, limit) }
        },
        stream: ({ agentId, afterSeq = 0 }, context) => workerEventStream(store, requireAgent(agentId), agentId, afterSeq, context),
      }
      scope.provide(CONTROL_OPERATIONS, operations)
      registerOperation(scope, controlAgentsList, () => operations.listAgents())
      registerOperation(scope, controlAgentStatus, operations.status)
      registerOperation(scope, controlAgentOverview, operations.overview)
      registerOperation(scope, controlAgentEvents, operations.events)
      registerOperation(scope, controlAgentCompactions, operations.compactions)
      registerOperation(scope, controlEnqueue, operations.enqueue)
      registerOperation(scope, controlShutdown, operations.shutdown)
      registerOperation(scope, controlCron, operations.cron)
      registerOperation(scope, controlClientConnect, operations.clientConnect)
      registerOperation(scope, controlClientDisconnect, operations.clientDisconnect)
      registerOperation(scope, controlClientStatus, operations.clientStatus)
      registerOperation(scope, controlDiscordChannels, operations.discordChannels)
      registerOperation(scope, controlDiscordMessages, operations.discordMessages)
      registerStream(scope, controlAgentStream, operations.stream)
    },
  }
}
