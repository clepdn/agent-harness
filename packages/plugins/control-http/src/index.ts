import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify"
import { findService, getService, listContributions, type Plugin } from "@nano/plugins"
import { nanoOperations, nanoRpcAuth, nanoStreams, type RpcAuthService } from "@nano/protocol/rpc"
import { controlAgentCompactions, controlAgentEvents, controlAgentOverview, controlAgentStatus, controlAgentStream, controlAgentsList, controlClientConnect, controlClientDisconnect, controlClientStatus, controlCron, controlDiscordChannels, controlDiscordMessages, controlEnqueue, controlShutdown, type OperationDescriptor, type OperationOutput, type StreamDescriptor } from "@nano/protocol"
import type { JsonValue } from "@nano/protocol"
import { authenticateRpcRequest, invokeRpcOperation, prepareRpcStream, registerRpcTransport, rpcErrorStatus, rpcErrorValue, type PreparedRpcStream, type RpcGatewayOptions, type RpcIdentity } from "@nano/runtime-api/rpc-gateway"
import { CONTROL_AGENTS, CONTROL_HTTP, CONTROL_STATIC_UI, CONTROL_STORE, type ControlStaticUi, type ControlStore } from "@nano/control-api"

export type ControlHttpOptions = {
  staticUi?: boolean
  maxBodyBytes?: number
  maxFrameBytes?: number
}

const requestIdentities = new WeakMap<FastifyRequest, RpcIdentity>()

function rpcRouteError(reply: FastifyReply, error: unknown, fallback = 502) {
  const rpcError = rpcErrorValue(error)
  return reply.code(rpcError.code === "INTERNAL" ? fallback : rpcErrorStatus(error)).send({ error: rpcError.message })
}

function failStream(reply: FastifyReply, error: unknown) {
  if (!reply.raw.destroyed) {
    reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: rpcErrorValue(error).message })}\n\n`)
    reply.raw.end()
  }
}

async function authenticateLegacy(request: FastifyRequest, reply: FastifyReply, auth: RpcAuthService): Promise<boolean> {
  try {
    requestIdentities.set(request, await authenticateRpcRequest(request, auth))
    return true
  } catch (error) {
    await rpcRouteError(reply, error, 401)
    return false
  }
}

function installLegacyAuth(app: FastifyInstance, auth: RpcAuthService): void {
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS" || request.url.startsWith("/rpc/")) return
    if (!await authenticateLegacy(request, reply, auth)) return reply
  })
}

function requireAgent(store: ControlStore, configuredAgentIds: ReadonlySet<string>, id: string): boolean {
  return configuredAgentIds.has(id) && store.getAgent(id) !== null
}

async function routeOperation<D extends OperationDescriptor>(gateway: RpcGatewayOptions, request: FastifyRequest, reply: FastifyReply, descriptor: D, input: unknown): Promise<OperationOutput<D> | FastifyReply | undefined> {
  const controller = new AbortController()
  const onAborted = () => controller.abort()
  const onClose = () => { if (!reply.raw.writableEnded) controller.abort() }
  request.raw.once("aborted", onAborted)
  reply.raw.once("close", onClose)
  try {
    return await invokeRpcOperation(gateway, descriptor, input, request, controller.signal, requestIdentities.get(request))
  } catch (error) {
    return rpcRouteError(reply, error)
  } finally {
    request.raw.off("aborted", onAborted)
    reply.raw.off("close", onClose)
  }
}

async function routeStream<D extends StreamDescriptor>(gateway: RpcGatewayOptions, request: FastifyRequest, reply: FastifyReply, descriptor: D, input: unknown): Promise<void | FastifyReply> {
  let prepared: PreparedRpcStream<D>
  try {
    prepared = await prepareRpcStream(gateway, descriptor, input, request, requestIdentities.get(request))
  } catch (error) {
    return rpcRouteError(reply, error)
  }
  reply.hijack()
  const response = reply.raw
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" })
  response.write(":ok\n\n")
  const controller = new AbortController()
  const onAborted = () => controller.abort()
  const onClose = () => controller.abort()
  request.raw.once("aborted", onAborted)
  response.once("close", onClose)
  try {
    for await (const event of prepared.run(controller.signal)) {
      if (response.destroyed) break
      response.write(`data: ${JSON.stringify(event)}\n\n`)
    }
  } catch (error) {
    if (!controller.signal.aborted && !response.destroyed) failStream(reply, error)
  } finally {
    controller.abort()
    request.raw.off("aborted", onAborted)
    response.off("close", onClose)
    if (!response.writableEnded && !response.destroyed) response.end()
  }
}
export function registerControlRoutes(
  app: FastifyInstance,
  services: { store: ControlStore; configuredAgentIds: ReadonlySet<string>; ui?: ControlStaticUi },
  gateway: RpcGatewayOptions,
): void {
  const { store, configuredAgentIds } = services
  const agentExists = (id: string) => requireAgent(store, configuredAgentIds, id)
  app.options("/*", async (_request, reply) => reply.code(204).send())

  app.get("/health", async () => ({ ok: true }))
  app.get("/agents", async (request, reply) => routeOperation(gateway, request, reply, controlAgentsList, {}))

  app.get("/agents/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!agentExists(id)) return reply.code(404).send({ error: "agent not found" })
    return routeOperation(gateway, request, reply, controlAgentStatus, { agentId: id })
  })

  app.get("/agents/:id/overview", async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!agentExists(id)) return reply.code(404).send({ error: "agent not found" })
    return routeOperation(gateway, request, reply, controlAgentOverview, { agentId: id })
  })

  app.post("/agents/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!agentExists(id)) return reply.code(404).send({ error: "agent not found" })
    const raw = request.body
    const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    let commandBody: unknown
    if (body.type === "event.enqueue") {
      if (!body.event) return reply.code(400).send({ error: "expected content or event.enqueue command" })
      commandBody = raw
    } else {
      const content = typeof body.content === "string" ? body.content.trim() : ""
      if (!content) return reply.code(400).send({ error: "expected content or event.enqueue command" })
      commandBody = { content, ...(typeof body.clientId === "string" ? { clientId: body.clientId } : {}) }
    }
    return routeOperation(gateway, request, reply, controlEnqueue, { agentId: id, body: commandBody as JsonValue })
  })

  app.post("/agents/:id/shutdown", async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!agentExists(id)) return reply.code(404).send({ error: "agent not found" })
    return routeOperation(gateway, request, reply, controlShutdown, { agentId: id })
  })

  app.post("/agents/:id/trigger/cron", async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!agentExists(id)) return reply.code(404).send({ error: "agent not found" })
    return routeOperation(gateway, request, reply, controlCron, { agentId: id, body: request.body as JsonValue })
  })

  app.get("/agents/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!agentExists(id)) return reply.code(404).send({ error: "agent not found" })
    const query = request.query as { after_seq?: string; limit?: string; tail?: string; view?: string }
    const input = { agentId: id, afterSeq: Number.parseInt(query.after_seq ?? "0", 10) || 0, limit: Number.parseInt(query.limit ?? "500", 10) || 500, tail: query.tail === "1" || query.tail === "true", view: query.view }
    return routeOperation(gateway, request, reply, controlAgentEvents, input)
  })

  app.get("/agents/:id/compactions", async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!agentExists(id)) return reply.code(404).send({ error: "agent not found" })
    const query = request.query as { limit?: string }
    return routeOperation(gateway, request, reply, controlAgentCompactions, { agentId: id, limit: Number.parseInt(query.limit ?? "20", 10) || 20 })
  })

  app.get("/agents/:id/stream", async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!agentExists(id)) return reply.code(404).send({ error: "agent not found" })
    const query = request.query as { after_seq?: string }
    return routeStream(gateway, request, reply, controlAgentStream, { agentId: id, afterSeq: Number.parseInt(query.after_seq ?? "0", 10) || 0 })
  })

  app.post("/agents/:id/client/connect", async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!agentExists(id)) return reply.code(404).send({ error: "agent not found" })
    return routeOperation(gateway, request, reply, controlClientConnect, { agentId: id, body: request.body as JsonValue })
  })
  app.post("/agents/:id/client/disconnect", async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!agentExists(id)) return reply.code(404).send({ error: "agent not found" })
    return routeOperation(gateway, request, reply, controlClientDisconnect, { agentId: id })
  })
  app.get("/agents/:id/client/status", async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!agentExists(id)) return reply.code(404).send({ error: "agent not found" })
    return routeOperation(gateway, request, reply, controlClientStatus, { agentId: id })
  })
  app.get("/agents/:id/discord/channels", async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!agentExists(id)) return reply.code(404).send({ error: "agent not found" })
    return routeOperation(gateway, request, reply, controlDiscordChannels, { agentId: id })
  })
  app.get("/agents/:id/discord/channels/:channelId/messages", async (request, reply) => {
    const { id, channelId } = request.params as { id: string; channelId: string }
    if (!agentExists(id)) return reply.code(404).send({ error: "agent not found" })
    const query = request.query as { before?: string; limit?: string }
    return routeOperation(gateway, request, reply, controlDiscordMessages, { agentId: id, channelId, before: query.before, limit: query.limit ? Number.parseInt(query.limit, 10) : undefined })
  })

  app.get("/ui", async (_request, reply) => {
    if (services.ui) return services.ui.serve(undefined, reply)
    return reply.code(503).send({ error: "web ui is not built yet. run `npm run build:web` first." })
  })
  app.get("/ui/*", async (request, reply) => {
    if (services.ui) return services.ui.serve((request.params as { "*"?: string })["*"], reply)
    return reply.code(503).send({ error: "web ui is not built yet. run `npm run build:web` first." })
  })
}


export function controlHttpPlugin(options: ControlHttpOptions): Plugin.Object<unknown> {
  return {
    name: "control.http",
    inject: [CONTROL_STORE.name, CONTROL_AGENTS.name, nanoRpcAuth.name, "nano.contributions"],
    provide: [CONTROL_HTTP.name],
    async apply(ctx) {
      const app = Fastify({ logger: false, bodyLimit: options.maxBodyBytes ?? 2_000_000 })
      ctx.effect(() => () => app.close())
      const store = getService(ctx, CONTROL_STORE)
      const agents = getService(ctx, CONTROL_AGENTS)
      const auth = getService(ctx, nanoRpcAuth)
      const ui = options.staticUi === false ? undefined : findService(ctx, CONTROL_STATIC_UI)
      const gateway: RpcGatewayOptions = {
        operations: () => listContributions(ctx, nanoOperations),
        streams: () => listContributions(ctx, nanoStreams),
        auth: () => auth,
        maxBodyBytes: options.maxBodyBytes,
        maxFrameBytes: options.maxFrameBytes,
      }
      installLegacyAuth(app, auth)
      registerControlRoutes(app, { store, configuredAgentIds: agents.configuredAgentIds, ui }, gateway)
      await registerRpcTransport(app, gateway)
      ctx.provide(CONTROL_HTTP.name, app)
    },
  }
}
