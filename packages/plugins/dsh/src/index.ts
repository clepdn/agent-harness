import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { WebSocket } from "ws"
import type { Plugin } from "@nano/plugins"
import { findService, getService, nano, registerContribution, type RpcAuthService } from "@nano/runtime-api"
import { AGENT_ID } from "@nano/runtime-api/agent-config"
import { nanoHttpRoutes } from "@nano/runtime-api/http"
import { authorizeRpcRequest } from "@nano/runtime-api/rpc-gateway"
import { DshAssets, type DshAssetResponse } from "./assets"
import type { ModelSource } from "./encoder"
import { LiveSession } from "./live"

/** The one DSH session: Nano's main-lane conversation. */
export const DSH_SESSION_ID = "nano"
const WORKSPACE_ID = "nano"
const MOUNT = "/dsh"
const DEFAULT_MAX_MESSAGES = 500

class DshError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

type Args = Record<string, unknown>
type Emit = (value: unknown) => void

function record(value: unknown): Args {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Args : {}
}

/** The generated DSH client packs one named request object; accept its known parameter names. */
function requestArgs(args: Args): Args {
  return record(args.request ?? args._request ?? args)
}

function sendAsset(reply: FastifyReply, asset: DshAssetResponse | undefined): FastifyReply {
  if (!asset) return reply.code(404).send()
  return reply
    .header("content-type", asset.contentType)
    .header("cache-control", asset.immutable ? "public, max-age=31536000, immutable" : "no-cache")
    .send(asset.body)
}

export const dshPlugin: Plugin = {
  name: "nano.dsh",
  inject: [nano.persistence.name, nano.conversation.name, nano.events.name, nano.runner.name, nano.rpcAuth.name, "nano.contributions"],
  apply(ctx) {
    const persistence = getService(ctx, nano.persistence)
    const conversation = getService(ctx, nano.conversation)
    const events = getService(ctx, nano.events)
    const runner = getService(ctx, nano.runner)
    const auth: RpcAuthService = getService(ctx, nano.rpcAuth)
    const model = findService(ctx, nano.model)
    const assets = new DshAssets()
    const createdAt = Date.now()
    const cwd = persistence.home
    const source = (): ModelSource => {
      const state = model?.current("main")
      const active = state && (state.useFallback || !state.primaryModel ? state.fallbackModel : state.primaryModel)
      return { provider: active?.provider ?? "nano", model: active?.id ?? "nano" }
    }
    const session = new LiveSession(() => persistence.getDb(), source, runner.status().running)
    ctx.effect(() => persistence.subscribeWorkerEvents((event) => session.acceptWorkerEvent(event)))
    ctx.effect(() => events.subscribeLive((event) => session.acceptStreamEvent(event)))

    const authorize = async (request: FastifyRequest, permission: string, method: string, input: unknown): Promise<void> => {
      const allowed = await authorizeRpcRequest({ method, permission, input, headers: request.headers, hostname: request.hostname }, auth)
      if (!allowed) throw new DshError("gateway/permission-denied", `${method} requires ${permission}`)
    }
    const requireSession = (args: Args): void => {
      const sessionId = args.sessionId ?? record(args.address).sessionId
      if (sessionId !== DSH_SESSION_ID) throw new DshError("session/not-found", `unknown session ${String(sessionId)}`)
    }
    const projections = () => ({
      asOfSeq: session.cursor,
      values: {
        title: AGENT_ID,
        inbox: { "next-turn": [], "next-step": [] },
        modelSelection: { lastUsed: null, next: null },
        sessionListMetadata: { blank: false, lastPromptAt: null },
      },
    })
    const summary = () => ({
      sessionId: DSH_SESSION_ID, updatedAt: session.updatedAt, agentAvailable: true, running: session.running, blank: false, cwd,
      projections: { kind: "sequenced", ...projections() },
    })
    const workspace = () => ({
      workspaceId: WORKSPACE_ID, path: cwd, title: AGENT_ID, sessionIds: [DSH_SESSION_ID],
      createdAt: new Date(createdAt).toISOString(), updatedAt: new Date(session.updatedAt).toISOString(),
    })
    const page = (args: Args) => {
      requireSession(args)
      const maxMessages = typeof args.maxMessages === "number" ? args.maxMessages : DEFAULT_MAX_MESSAGES
      // A `beforeSeq` page prepends older history; without it the client is repairing up to `throughSeq`.
      const { records, hasMore } = typeof args.beforeSeq === "number"
        ? session.before(args.beforeSeq, maxMessages)
        : session.through(typeof args.throughSeq === "number" ? args.throughSeq : session.cursor, maxMessages)
      return { records: records.map((event) => ({ type: "event", event })), hasMore }
    }

    const unary: Record<string, (args: Args, request: FastifyRequest) => unknown> = {
      "session/list": () => ({ items: [summary()] }),
      "session/create": () => ({ sessionId: DSH_SESSION_ID }),
      "session/search": () => ({ items: [], hasMore: false }),
      "session/projections": (args) => { requireSession(requestArgs(args)); return projections() },
      "session/page": (args) => page(requestArgs(args)),
      "session/modelCatalog": () => ({ default: source(), routableProviders: [], groups: [], failures: [] }),
      "session/initializeDefaultModel": () => null,
      "session/prompt": async (args, request) => {
        const input = requestArgs(args)
        requireSession(input)
        await authorize(request, "conversation.write", "session/prompt", input)
        const parts = Array.isArray(input.content) ? input.content.map(record) : []
        if (parts.some((part) => part.type !== "text")) throw new DshError("session/unsupported-content", "Nano accepts text prompts only")
        const content = parts.map((part) => String(part.text ?? "")).join("\n").trim()
        if (!content) throw new DshError("session/empty-prompt", "prompt is empty")
        const requestId = typeof input.requestId === "string" ? input.requestId : randomUUID()
        session.expectPrompt(requestId, content)
        await conversation.submit({ event: { source: "chat", triggeredAt: new Date().toISOString(), content, clientId: `dsh-${requestId}`, raw: { dsh: { requestId } } }, runtimeKind: "main" })
        return { accepted: true }
      },
      "session/cancel": async (args, request) => {
        const input = requestArgs(args)
        requireSession(input)
        await authorize(request, "conversation.write", "session/cancel", input)
        await conversation.cancel({ runtimeKind: "main" })
        return { accepted: true }
      },
      "workspace/initializeDefault": () => ({ workspace: workspace() }),
      "settings/describe": () => ({ writable: false, hasDocument: false, namespaces: [] }),
      "commands/list": () => [],
      "$events/result": () => null,
    }

    /** Opens one mux stream; returns its cleanup. */
    const streams: Record<string, (args: Args, emit: Emit, end: () => void) => (() => void) | void> = {
      "$events": (_args, emit) => {
        emit({ type: "ready", clientId: randomUUID(), host: { home: cwd } })
        let running = session.running
        return session.onStatus((nextRunning, updatedAt) => {
          if (nextRunning !== running) emit({ type: "emit", event: "api-session/status", args: [DSH_SESSION_ID, nextRunning] })
          running = nextRunning
          emit({ type: "emit", event: "api-session/activity", args: [DSH_SESSION_ID, updatedAt] })
        })
      },
      "session/control": (_args, emit) => { emit({ type: "baseline", value: { projections: {} } }) },
      "workspace/follow": (_args, emit) => { emit({ type: "baseline", value: { items: [workspace()], archivedSessionIds: [], pinnedSessionIds: [] } }) },
      "session/page": (args, emit, end) => { emit(page(requestArgs(args))); end() },
      "session/follow": (args, emit) => {
        const input = requestArgs(args)
        const address = record(input.address)
        if (address.kind !== "session") throw new DshError("session/not-found", "Nano has no subagent sessions")
        requireSession(input)
        if (input.assistantStream !== true) throw new DshError("gateway/arguments-invalid", "session/follow requires assistantStream")
        const maxMessages = typeof input.maxMessages === "number" ? input.maxMessages : DEFAULT_MAX_MESSAGES
        const { records, hasMore, activeAttempt } = session.snapshot(maxMessages)
        emit({
          type: "snapshot",
          header: { version: 4, id: DSH_SESSION_ID, createdAt, cwd, isSeeded: false },
          cursor: records.at(-1)?.seq ?? -1,
          records: records.map((event) => ({ type: "event", event })),
          hasMore,
          projections: projections(),
          assistantStream: { revision: 0, ...(activeAttempt ? { activeAttempt } : {}) },
        })
        let revision = 0
        return session.follow({
          event: (event) => emit({ type: "event", event }),
          frame: (frame) => emit({ type: "assistant-stream", frame: { ...frame, revision: ++revision } }),
        })
      },
    }

    const installRoutes = (app: FastifyInstance): void => {
      app.register(async (scope) => {
        // Document-relative app URLs need the trailing slash; redirect the bare mount to it.
        scope.get("/", { prefixTrailingSlash: "no-slash" }, (_request, reply) => reply.redirect("dsh/"))
        scope.get("/", { prefixTrailingSlash: "slash" }, (_request, reply) => reply.header("content-type", "text/html; charset=utf-8").header("cache-control", "no-store").send(assets.index))
        scope.get("/plugins/*", (request, reply) => {
          const raw = request.raw.url ?? ""
          return sendAsset(reply, assets.plugin(raw.slice(raw.indexOf("/plugins/") + "/plugins/".length)))
        })
        scope.get<{ Params: { "*": string } }>("/assets/*", (request, reply) => sendAsset(reply, assets.dist(`assets/${request.params["*"]}`)))
        for (const file of ["favicon.svg", "favicon-dark.svg", "manifest.webmanifest"]) {
          scope.get(`/${file}`, (_request, reply) => sendAsset(reply, assets.dist(file)))
        }

        scope.post<{ Params: { "*": string } }>("/api/*", async (request, reply) => {
          const method = request.params["*"]
          const body = record(request.body)
          if (body.type !== "client-request" || typeof body.rpcId !== "string" || body.method !== method) {
            return reply.code(400).send({ error: "invalid DSH client request" })
          }
          const respond = (result: unknown) => reply.header("content-type", "application/json").send({ type: "server-response", rpcId: body.rpcId, result })
          const handler = unary[method]
          try {
            if (!handler) throw new DshError("gateway/endpoint-unavailable", `${method} is not provided by Nano`)
            await authorize(request, "conversation.read", method, body.payload)
            return respond({ ok: true, value: await handler(record(record(body.payload).args), request) ?? null })
          } catch (error) {
            const code = error instanceof DshError ? error.code : "gateway/internal"
            const message = error instanceof Error ? error.message : String(error)
            return respond({ ok: false, error: { code, message, details: {} } })
          }
        })

        scope.get("/api/remote.mux", { websocket: true }, (socket: WebSocket, request) => {
          const open = new Map<string, () => void>()
          const send = (frame: unknown): void => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame)) }
          const ready = authorize(request, "conversation.read", "remote.mux", null)
            .then(() => true, () => { socket.close(1008, "permission denied"); return false })
          socket.on("message", async (data) => {
            if (!await ready) return
            let frame: Args
            try { frame = record(JSON.parse(String(data))) } catch { socket.close(1003, "invalid frame"); return }
            const streamId = typeof frame.streamId === "string" ? frame.streamId : undefined
            if (!streamId) return
            if (frame.type === "cancel" || frame.type === "end") {
              open.get(streamId)?.()
              open.delete(streamId)
              return
            }
            if (frame.type !== "open" || open.has(streamId)) return
            const endpoint = String(frame.endpoint)
            const end = (): void => { open.get(streamId)?.(); open.delete(streamId); send({ type: "end", streamId }) }
            try {
              const opener = streams[endpoint]
              if (!opener) throw new DshError("gateway/endpoint-unavailable", `${endpoint} is not provided by Nano`)
              open.set(streamId, () => {})
              const cleanup = opener(record(record(frame.payload).args), (value) => send({ type: "item", streamId, value }), end)
              if (open.has(streamId)) open.set(streamId, cleanup ?? (() => {}))
              else cleanup?.()
            } catch (error) {
              open.delete(streamId)
              const code = error instanceof DshError ? error.code : "gateway/internal"
              send({ type: "error", streamId, error: { code, message: error instanceof Error ? error.message : String(error), details: {} } })
            }
          })
          socket.on("close", () => {
            for (const cleanup of open.values()) cleanup()
            open.clear()
          })
        })
      }, { prefix: MOUNT })
    }
    registerContribution(ctx, nanoHttpRoutes, "nano.dsh", installRoutes)
  },
}
