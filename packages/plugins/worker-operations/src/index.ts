import type { Plugin } from "@nano/plugins"
import {
  workerAwpEnqueue,
  workerChatStream,
  workerChatSubmit,
  workerClientConnect,
  workerClientDisconnect,
  workerClientStatus,
  workerControlRestart,
  workerControlShutdown,
  workerDiscordChannels,
  workerDiscordIngress,
  workerDiscordMessages,
  workerDiscordMetricDetail,
  workerEvents,
  workerEventsList,
  workerMetricsDetail,
  workerMetricsList,
  workerModelGet,
  workerModelSwap,
  workerStatus,
  workerTriggerBsky,
  workerTriggerChat,
  workerTriggerCron,
  workerTriggerDiscord,
  workerTriggerWebhook,
  toJsonValue,
  type JsonValue,
  type ReplayStreamGap,
  type ReplayStreamItem,
  type StreamEvent,
  type UserMessage,
  type WorkerEvent,
  type WorkerMetricsPage,
  type WorkerStatusSnapshot,
} from "@nano/protocol"
import {
  findService,
  getService,
  nano,
  registerOperation,
  registerStream,
  type ClientService,
  type EventService,
  type MetricsService,
  type PersistenceService,
} from "@nano/runtime-api"
import type { WorkerMetricQuery } from "@nano/protocol"
import { isToolCapability, type WorkspaceDescriptor } from "@nano/harness-protocol"
import type { RemoteClientConnection } from "@nano/runtime-api/contracts/client"

type WorkerClientStatus = NonNullable<WorkerStatusSnapshot["client"]>
type MetricsQuery = NonNullable<Parameters<MetricsService["list"]>[0]>
type MetricListType = NonNullable<MetricsQuery["type"]>[number]

/** Public worker status/history/runner/model bindings. */
export const workerOperationsPlugin: Plugin = {
  name: "nano.worker-operations",
  inject: [nano.runner.name, nano.lifecycle.name, "nano.contributions"],
  apply(ctx) {
    const runner = getService(ctx, nano.runner)
    const lifecycle = getService(ctx, nano.lifecycle)
    registerOperation(ctx, workerStatus, (_input, context) => {
      checkSignal(context.signal)
      const status = runner.status()
      const client = findService(ctx, nano.client)
      return client === undefined ? status : { ...status, client: clientStatus(client) }
    })
    registerOperation(ctx, workerEventsList, (input, context) => {
      checkSignal(context.signal)
      return required(findService(ctx, nano.persistence), "nano.persistence").listWorkerEvents(input.afterSeq, input.limit, input.tail ? "tail" : "after")
    })
    registerStream(ctx, workerEvents, (input, context) => {
      return workerEventStream(required(findService(ctx, nano.persistence), "nano.persistence"), input, context.signal)
    })
    registerOperation(ctx, workerAwpEnqueue, (input, context) => {
      checkSignal(context.signal)
      const status = runner.status()
      let accepted: boolean
      if (status.running) accepted = runner.enqueue(input.event, input.options)
      else if (input.options?.onlyIfWaiting) accepted = false
      else {
        runner.activate(input.event)
        accepted = true
      }
      return { ok: accepted, running: runner.status().running }
    })
    registerOperation(ctx, workerChatSubmit, async (input, context) => {
      checkSignal(context.signal)
      const result = await required(findService(ctx, nano.conversation), "nano.conversation").submit({ event: chatMessage(input.content, input.clientId) })
      if (!result.accepted) {
        throw Object.assign(new Error("chat submission was rejected"), { code: "UNAVAILABLE" })
      }
      return { ok: true as const, running: result.running }
    })
    registerStream(ctx, workerChatStream, (_input, context) => {
      return chatStream(required(findService(ctx, nano.events), "nano.events"), context.signal)
    })
    registerOperation(ctx, workerModelGet, (_input, context) => {
      checkSignal(context.signal)
      return runner.modelSnapshot()
    })
    registerOperation(ctx, workerModelSwap, async (input, context) => {
      checkSignal(context.signal)
      const result = await runner.swapModel(input.preset)
      return { ok: true, action: "swapped", ...result }
    })
    registerOperation(ctx, workerTriggerDiscord, (input, context) => {
      checkSignal(context.signal)
      return runner.trigger("discord", input.body, context.signal)
    })
    registerOperation(ctx, workerTriggerBsky, (input, context) => {
      checkSignal(context.signal)
      return runner.trigger("bsky", input.body, context.signal)
    })
    registerOperation(ctx, workerTriggerWebhook, (input, context) => {
      checkSignal(context.signal)
      return runner.trigger("webhook", input.body, context.signal)
    })
    registerOperation(ctx, workerTriggerCron, (input, context) => {
      checkSignal(context.signal)
      return runner.trigger("cron", input.body, context.signal)
    })
    registerOperation(ctx, workerTriggerChat, (input, context) => {
      checkSignal(context.signal)
      return runner.trigger("chat", input.body, context.signal)
    })
    registerOperation(ctx, workerControlShutdown, (_input, context) => {
      checkSignal(context.signal)
      lifecycle.shutdown()
      return { ok: true }
    })
    registerOperation(ctx, workerControlRestart, (input, context) => {
      checkSignal(context.signal)
      lifecycle.restart(input.reason)
      return { ok: true }
    })
  },
}

/** Discord operations are independently unloadable from runner/provider operations. */
export const workerDiscordOperationsPlugin: Plugin = {
  name: "nano.worker-discord-operations",
  inject: [nano.discord.name, "nano.contributions"],
  apply(ctx) {
    const discord = getService(ctx, nano.discord)
    registerOperation(ctx, workerDiscordChannels, (_input, context) => {
      checkSignal(context.signal)
      return [...discord.channels()]
    })
    registerOperation(ctx, workerDiscordMessages, (input, context) => {
      checkSignal(context.signal)
      return [...discord.messages(input.channelId, input.before, input.limit)]
    })
    registerOperation(ctx, workerDiscordIngress, async (input, context) => {
      checkSignal(context.signal)
      return discord.ingress(input.body, context.signal)
    })
  },
}

/** Client operations are independently unloadable from Discord/provider capabilities. */
export const workerClientOperationsPlugin: Plugin = {
  name: "nano.worker-client-operations",
  inject: [nano.client.name, "nano.contributions"],
  apply(ctx) {
    const client = getService(ctx, nano.client)
    registerOperation(ctx, workerClientStatus, (_input, context) => {
      checkSignal(context.signal)
      return clientStatus(client)
    })
    registerOperation(ctx, workerClientConnect, async (input, context) => {
      checkSignal(context.signal)
      try {
        const info = await client.connect(clientConnection(input.endpoint, input.workspace, input.capabilities), context.signal)
        return { ok: true, notified: true, client: info, status: client.status() }
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && typeof error.code === "string") throw error
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "UNAVAILABLE" as const })
      }
    })
    registerOperation(ctx, workerClientDisconnect, async (_input, context) => {
      checkSignal(context.signal)
      const info = await client.disconnect()
      return { ok: true, notified: true, client: info, status: client.status() }
    })
  },
}

/** Metrics operations are independently unloadable from Discord/client capabilities. */
export const workerMetricsOperationsPlugin: Plugin = {
  name: "nano.worker-metrics-operations",
  inject: [nano.metrics.name, "nano.contributions"],
  apply(ctx) {
    const metrics = getService(ctx, nano.metrics)
    registerOperation(ctx, workerMetricsList, (input, context) => {
      checkSignal(context.signal)
      return metricsPage(metrics.list(metricsQuery(input)))
    })
    registerOperation(ctx, workerMetricsDetail, (input, context) => {
      checkSignal(context.signal)
      return metricDetail(metrics.detail(input.id), "metric")
    })
    registerOperation(ctx, workerDiscordMetricDetail, (input, context) => {
      checkSignal(context.signal)
      return metricDetail(metrics.discordDetail(input.id), "discord metric")
    })
  },
}

function metricsPage(value: unknown): WorkerMetricsPage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("metrics list returned an invalid page")
  return value as WorkerMetricsPage
}

function metricDetail(value: unknown, label: string): JsonValue {
  if (value === undefined || value === null) {
    throw Object.assign(new Error(`${label} not found`), { code: "NOT_FOUND" })
  }
  return toJsonValue(value)
}
function required<T>(service: T | undefined, name: string): T {
  if (service !== undefined) return service
  throw Object.assign(new Error(`${name} service is unavailable`), { code: "UNAVAILABLE" })
}

function checkSignal(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw Object.assign(signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled"), { code: "CANCELLED" })
}


function chatMessage(content: string, clientId?: string): UserMessage {
  const raw: Record<string, string> = clientId === undefined ? { content } : { content, clientId }
  if (clientId === undefined) {
    return { source: "chat", triggeredAt: new Date().toISOString(), content, raw }
  }
  return { source: "chat", triggeredAt: new Date().toISOString(), content, raw, clientId }
}

function clientStatus(client: ClientService): WorkerClientStatus {
  const status = client.status()
  const info = client.info()
  return {
    connected: status.connected,
    agentId: status.agentId,
    clientId: status.clientId,
    capabilities: [...status.capabilities],
    workspace: client.workspace(),
    ...(status.lastSeenAt === undefined ? {} : { lastSeenAt: status.lastSeenAt }),
    pendingInvocations: status.pendingInvocations,
    ...(info.remote ? { remote: true } : {}),
    ...(info.connectedAt === undefined ? {} : { connectedAt: info.connectedAt }),
  }
}

function clientConnection(endpoint: string, workspace: JsonValue | undefined, capabilities: string[] | undefined): RemoteClientConnection {
  const connection: RemoteClientConnection = { endpoint }
  if (workspace !== undefined) connection.workspace = workspaceDescriptor(workspace)
  if (capabilities !== undefined) connection.capabilities = capabilities.filter(isToolCapability)
  return connection
}

function workspaceDescriptor(value: JsonValue): WorkspaceDescriptor {
  if (value === null || Array.isArray(value) || typeof value !== "object") invalidArgument("workspace must be an object")
  if (typeof value.id !== "string" || typeof value.root !== "string") invalidArgument("workspace requires id and root")
  return {
    id: value.id,
    root: value.root,
    ...(typeof value.home === "string" ? { home: value.home } : {}),
    ...(typeof value.imageRoot === "string" ? { imageRoot: value.imageRoot } : {}),
    ...(typeof value.platform === "string" ? { platform: value.platform } : {}),
    ...(typeof value.persistentShell === "boolean" ? { persistentShell: value.persistentShell } : {}),
    ...(typeof value.hashline === "boolean" ? { hashline: value.hashline } : {}),
  }
}

function invalidArgument(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_ARGUMENT" })
}


function metricsQuery(input: WorkerMetricQuery): MetricsQuery {
  const aliases: Record<string, MetricListType> = {
    compaction: "summarization",
    summary: "summarization",
    summaries: "summarization",
    memory: "memory",
    memories: "memory",
    response: "response",
    prompt_response: "response",
    "prompt-response": "response",
    completion: "response",
    usage: "usage",
    discord: "discord",
  }
  const types: MetricListType[] = []
  for (const raw of input.type ?? []) {
    const normalized = raw.trim().toLowerCase()
    const value = aliases[normalized]
    if (value !== undefined && !types.includes(value)) types.push(value)
  }
  return {
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.cursors === undefined ? {} : { cursors: input.cursors }),
    ...(types.length === 0 ? {} : { type: types }),
    ...(input.includeRaw === undefined ? {} : { includeRaw: input.includeRaw }),
    ...(input.q === undefined ? {} : { q: input.q }),
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.to === undefined ? {} : { to: input.to }),
  }
}

async function* chatStream(events: EventService, signal: AbortSignal): AsyncIterable<StreamEvent> {
  const queue: StreamEvent[] = []
  let wake: (() => void) | undefined
  let closed = false
  const unsubscribe = events.subscribeLive((event) => {
    if (closed) return
    queue.push(event)
    wake?.()
    wake = undefined
  })
  const close = (): void => {
    if (closed) return
    closed = true
    unsubscribe()
    wake?.()
    wake = undefined
  }
  signal.addEventListener("abort", close, { once: true })
  try {
    while (!signal.aborted) {
      if (!queue.length) await new Promise<void>((resolve) => { wake = resolve })
      if (signal.aborted) return
      const event = queue.shift()
      if (event !== undefined) yield event
    }
  } finally {
    signal.removeEventListener("abort", close)
    close()
  }
}

async function* workerEventStream(
  persistence: PersistenceService,
  input: { afterSeq?: number; limit?: number },
  signal: AbortSignal,
): AsyncIterable<ReplayStreamItem<WorkerEvent> | ReplayStreamGap> {
  const after = Math.max(0, Math.trunc(input.afterSeq ?? 0))
  const limit = Math.max(1, Math.min(1000, Math.trunc(input.limit ?? 500)))
  const queue: WorkerEvent[] = []
  let wake: (() => void) | undefined
  let replaying = true
  let closed = false
  const unsubscribe = persistence.subscribeWorkerEvents((event) => {
    if (closed) return
    if (queue.length >= 1024) queue.shift()
    queue.push(event)
    if (!replaying) {
      wake?.()
      wake = undefined
    }
  })
  const close = (): void => {
    if (closed) return
    closed = true
    unsubscribe()
    wake?.()
    wake = undefined
  }
  signal.addEventListener("abort", close, { once: true })
  const bounds = persistence.workerEventBounds()
  if (after > 0 && bounds.oldestSeq > 0 && after < bounds.oldestSeq - 1) {
    signal.removeEventListener("abort", close)
    close()
    yield { after, availableFrom: bounds.oldestSeq, latest: bounds.latestSeq }
    return
  }
  const seen = new Set<string>()
  let lastSeq = after
  try {
    for (const event of persistence.listWorkerEvents(after, limit, "after")) {
      if (signal.aborted) return
      if (seen.has(event.id)) continue
      seen.add(event.id)
      if (event.seq > 0) lastSeq = Math.max(lastSeq, event.seq)
      yield { seq: event.seq, volatile: event.seq === 0, value: event }
    }
    replaying = false
    while (!signal.aborted) {
      if (!queue.length) await new Promise<void>((resolve) => { wake = resolve; if (signal.aborted) close() })
      if (signal.aborted) return
      const event = queue.shift()
      if (event === undefined || seen.has(event.id)) continue
      if (event.seq > 0 && event.seq <= lastSeq) {
        seen.add(event.id)
        continue
      }
      seen.add(event.id)
      if (event.seq > 0) lastSeq = event.seq
      yield { seq: event.seq, volatile: event.seq === 0, value: event }
    }
  } finally {
    signal.removeEventListener("abort", close)
    close()
  }
}
