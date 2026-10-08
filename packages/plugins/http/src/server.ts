import { formatEventStreamItem } from "@nano/plugin-events"
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify"
import { AGENT_ID } from "@nano/runtime-api/agent-config"
import { rpcGatewayPlugin, invokeRpcOperation, prepareRpcStream, authenticateRpcRequest, rpcErrorStatus, rpcErrorValue } from "@nano/runtime-api/rpc-gateway"
import type { RpcGatewayOptions, RpcIdentity, PreparedRpcStream } from "@nano/runtime-api/rpc-gateway"
import type { OperationDescriptor, OperationOutput, StreamDescriptor, StreamItem } from "@nano/protocol"
import {
  workerStatus, workerClientStatus, workerClientConnect, workerClientDisconnect, workerAwpEnqueue,
  workerEventsList, workerEvents, workerControlShutdown, workerControlRestart,
  workerTriggerDiscord, workerTriggerBsky, workerTriggerWebhook, workerTriggerCron, workerTriggerChat,
  workerModelGet, workerModelSwap, workerChatStream, workerMetricsList, workerMetricsDetail, workerDiscordMetricDetail,
  workerDiscordChannels, workerDiscordMessages,
} from "@nano/protocol"
import type { ToolCapability } from "@nano/harness-protocol"

export function createServer(options: { rpcGateway?: RpcGatewayOptions } = {}) {
  const identities = new WeakMap<FastifyRequest, RpcIdentity>()

  function routeError(reply: FastifyReply, error: unknown, statusOverride?: number) {
    const rpcError = rpcErrorValue(error)
    return reply.code(statusOverride ?? rpcErrorStatus(error)).send({ error: rpcError.message, code: rpcError.code })
  }

  async function routeOperation<D extends OperationDescriptor>(request: FastifyRequest, reply: FastifyReply, descriptor: D, input: unknown): Promise<OperationOutput<D> | FastifyReply> {
    const gateway = options.rpcGateway
    if (!gateway) return routeError(reply, Object.assign(new Error("RPC operation registry is unavailable"), { code: "UNAVAILABLE" as const }))
    const controller = new AbortController()
    const onAborted = () => controller.abort()
    const onResponseClose = () => { if (!reply.raw.writableEnded) controller.abort() }
    request.raw.once("aborted", onAborted)
    reply.raw.once("close", onResponseClose)
    try {
      return await invokeRpcOperation(gateway, descriptor, input, request, controller.signal, identities.get(request))
    } catch (error) {
      return routeError(reply, error, descriptor === workerClientConnect && rpcErrorValue(error).code === "UNAVAILABLE" ? 502 : undefined)
    } finally {
      request.raw.off("aborted", onAborted)
      reply.raw.off("close", onResponseClose)
    }
  }

  async function routeStream<D extends StreamDescriptor>(request: FastifyRequest, reply: FastifyReply, descriptor: D, input: unknown, writeItem: (item: StreamItem<D>) => void): Promise<FastifyReply | void> {
    const gateway = options.rpcGateway
    if (!gateway) return routeError(reply, Object.assign(new Error("RPC stream registry is unavailable"), { code: "UNAVAILABLE" as const }))
    let prepared: PreparedRpcStream<D>
    try {
      prepared = await prepareRpcStream(gateway, descriptor, input, request, identities.get(request))
    } catch (error) {
      return routeError(reply, error)
    }
    reply.hijack()
    const response = reply.raw
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" })
    response.write(":ok\n\n")
    const controller = new AbortController()
    const onAborted = () => controller.abort()
    const onResponseClose = () => controller.abort()
    request.raw.once("aborted", onAborted)
    response.once("close", onResponseClose)
    try {
      for await (const item of prepared.run(controller.signal)) writeItem(item)
    } catch (error) {
      if (!controller.signal.aborted && !response.destroyed) response.write(`event: error\ndata: ${JSON.stringify(rpcErrorValue(error))}\n\n`)
    } finally {
      controller.abort()
      request.raw.off("aborted", onAborted)
      response.off("close", onResponseClose)
      if (!response.writableEnded && !response.destroyed) response.end()
    }
  }

  const imageMaxBytes = Math.max(1, Number.parseInt(process.env.IMAGE_TOOL_MAX_BYTES ?? "1000000", 10) || 1_000_000)
  const app = Fastify({ logger: false, bodyLimit: Math.max(2_000_000, imageMaxBytes * 2 + 1_000_000) })
  if (options.rpcGateway) app.register(rpcGatewayPlugin(options.rpcGateway))
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS" || request.url.startsWith("/rpc/")) return
    const gateway = options.rpcGateway
    if (!gateway) return
    try {
      identities.set(request, await authenticateRpcRequest(request, gateway.auth(), gateway))
    } catch (error) {
      return routeError(reply, error)
    }
  })

  app.options("/*", async (_req, reply) => reply.code(204).send())
  app.get("/health", async () => ({ ok: true, agentId: AGENT_ID, instanceId: process.env.NANO_WORKER_INSTANCE_ID?.trim() || null }))


  app.get("/awp/status", async (request, reply) => routeOperation(request, reply, workerStatus, {}))

  app.get("/awp/client/status", async (request, reply) => routeOperation(request, reply, workerClientStatus, {}))

  // Handshake: a client running from the operator's own working directory
  // connects out to this control plane and mounts its executor (pointed at its
  // pwd) as the active tool target. Tools then run directly against the
  // operator's files with no upload/abstraction step. Reverted on disconnect.
  app.post("/client/connect", async (req, reply) => {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {}
    const capabilities = Array.isArray(body.capabilities) ? body.capabilities.filter((value): value is ToolCapability => typeof value === "string") : undefined
    const input = { endpoint: body.endpoint, ...(body.workspace !== undefined ? { workspace: body.workspace } : {}), ...(capabilities ? { capabilities } : {}) }
    const result = await routeOperation(req, reply, workerClientConnect, input)
    if (reply.sent) return result
    return reply.send(result)
  })

  app.post("/client/disconnect", async (req, reply) => {
    const result = await routeOperation(req, reply, workerClientDisconnect, {})
    if (reply.sent) return result
    return reply.send(result)
  })

  app.post("/awp/events", async (req, reply) => {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {}
    const isCommand = body.type === "event.enqueue" && body.event && typeof body.event === "object"
    const event = isCommand ? body.event : body
    const options = isCommand && body.options && typeof body.options === "object" ? body.options : undefined
    const result = await routeOperation(req, reply, workerAwpEnqueue, { event, ...(options ? { options } : {}) })
    if (reply.sent) return result
    return reply.send(result)
  })

  app.get("/awp/events", async (req, reply) => {
    const query = req.query as { after_seq?: string; limit?: string; tail?: string }
    const result = await routeOperation(req, reply, workerEventsList, { afterSeq: Number.parseInt(query.after_seq ?? "0", 10) || 0, limit: Number.parseInt(query.limit ?? "500", 10) || 500, tail: query.tail === "1" || query.tail === "true" })
    if (reply.sent) return result
    return reply.send({ agentId: AGENT_ID, events: result })
  })

  app.post("/awp/shutdown", async (req, reply) => {
    const result = await routeOperation(req, reply, workerControlShutdown, {})
    if (reply.sent) return result
    return reply.send(result)
  })

  app.post("/awp/restart", async (req, reply) => {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {}
    const result = await routeOperation(req, reply, workerControlRestart, { ...(typeof body.reason === "string" ? { reason: body.reason } : {}) })
    if (reply.sent) return result
    return reply.send(result)
  })

  app.get("/awp/stream", async (req, reply) => {
    const query = req.query as { after_seq?: string; limit?: string }
    const afterSeq = Math.max(0, Number.parseInt(query.after_seq ?? "0", 10) || 0)
    const limit = Math.max(1, Math.min(1000, Number.parseInt(query.limit ?? "500", 10) || 500))
    return routeStream(req, reply, workerEvents, { afterSeq, limit }, (item) => reply.raw.write(formatEventStreamItem(item)))
  })

  app.post("/trigger/discord", async (req, reply) => {
    const result = await routeOperation(req, reply, workerTriggerDiscord, { body: req.body ?? null })
    if (reply.sent) return result
    return reply.send(result)
  })

  app.post("/trigger/bsky", async (req, reply) => {
    const result = await routeOperation(req, reply, workerTriggerBsky, { body: req.body ?? null })
    if (reply.sent) return result
    return reply.send(result)
  })
  app.get("/discord/channels", async (req, reply) => {
    const result = await routeOperation(req, reply, workerDiscordChannels, {})
    if (reply.sent) return result
    return reply.send({ agentId: AGENT_ID, channels: result })
  })

  app.get("/discord/channels/:channelId/messages", async (req, reply) => {
    const params = req.params as { channelId: string }
    const query = req.query as { before?: string; limit?: string }
    const result = await routeOperation(req, reply, workerDiscordMessages, {
      channelId: params.channelId,
      ...(query.before ? { before: query.before } : {}),
      ...(query.limit ? { limit: Number.parseInt(query.limit, 10) || 100 } : {}),
    })
    if (reply.sent) return result
    return reply.send({ agentId: AGENT_ID, channelId: params.channelId, messages: result })
  })
  app.post("/trigger/webhook", async (req, reply) => {
    const result = await routeOperation(req, reply, workerTriggerWebhook, { body: req.body ?? null })
    if (reply.sent) return result
    return reply.send(result)
  })

  app.post("/trigger/restart", async (req, reply) => {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {}
    const result = await routeOperation(req, reply, workerControlRestart, { reason: typeof body.reason === "string" ? body.reason : "webhook restart" })
    if (reply.sent) return result
    return reply.send(result)
  })

  // ── Model swap ──────────────────────────────────────────────────────────────
  // The endpoint below always uses the runner's bounded fresh-session handoff:
  // validate, journal/end or archive raw provenance, persist the preset, then
  // schedule a new bootstrap. It never mutates an active Context in place.

  app.get("/awp/model", async (req, reply) => {
    const result = await routeOperation(req, reply, workerModelGet, {})
    if (reply.sent) return result
    return reply.send(result)
  })

  app.post("/awp/swap-model", async (req, reply) => {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {}
    const result = await routeOperation(req, reply, workerModelSwap, { preset: body.preset })
    if (reply.sent) return result
    return reply.send(result)
  })

  app.post("/trigger/cron", async (req, reply) => {
    const result = await routeOperation(req, reply, workerTriggerCron, { body: req.body ?? null })
    if (reply.sent) return result
    return reply.send(result)
  })

  app.post("/trigger/chat", async (req, reply) => {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {}
    const result = await routeOperation(req, reply, workerTriggerChat, { body: { ...body, source: "chat", triggeredAt: new Date().toISOString(), content: body.content ?? "", raw: body } })
    if (reply.sent) return result
    return reply.send(result)
  })

  app.get("/chat/stream", async (req, reply) => {
    return routeStream(req, reply, workerChatStream, {}, (event) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`))
  })

  app.get("/status", async (req, reply) => routeOperation(req, reply, workerStatus, {}))

  app.get("/metrics", async (req, reply) => {
    const query = req.query as Record<string, string | undefined>
    const result = await routeOperation(req, reply, workerMetricsList, {
      limit: query.limit ? Number.parseInt(query.limit, 10) : undefined,
      cursor: query.cursor ? Number.parseInt(query.cursor, 10) : undefined,
      type: query.type,
      includeRaw: query.includeRaw === "true" || query.includeRaw === "1",
      q: query.q,
      from: query.from,
      to: query.to,
      cursors: { memories: query.cursor_memories, summarization: query.cursor_summarization, response: query.cursor_response, usage: query.cursor_usage, discord: query.cursor_discord },
    })
    if (reply.sent) return result
    return reply.send(result)
  })

  app.get("/metrics/discord/:id", async (req, reply) => {
    const params = req.params as { id: string }
    const result = await routeOperation(req, reply, workerDiscordMetricDetail, { id: params.id })
    if (reply.sent) return result
    return reply.send(result)
  })

  app.get("/metrics/:id", async (req, reply) => {
    const params = req.params as { id: string }
    const result = await routeOperation(req, reply, workerMetricsDetail, { id: Number.parseInt(params.id, 10) })
    if (reply.sent) return result
    return reply.send(result)
  })

  return app
}
