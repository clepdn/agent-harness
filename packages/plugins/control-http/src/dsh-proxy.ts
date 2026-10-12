import type { FastifyInstance } from "fastify"
import WebSocket from "ws"

/** Response headers the DSH page depends on; everything else stays hop-local. */
const FORWARDED_HEADERS = ["content-type", "cache-control"] as const
const REQUEST_TIMEOUT_MS = 30_000

/**
 * Expose each worker's DeepSeek Harness view (`/dsh/` on the worker's loopback
 * listener) at `/agents/:id/dsh/` on the control plane. The DSH page uses
 * document-relative URLs, so the prefix needs no rewriting. Requests reach this
 * code only after the control plane's own authentication hook.
 */
export function registerDshProxy(app: FastifyInstance, workerBaseUrl: (agentId: string) => string | undefined): void {
  app.get("/agents/:id/dsh", (_request, reply) => reply.redirect("dsh/"))

  app.get<{ Params: { id: string } }>("/agents/:id/dsh/api/remote.mux", { websocket: true }, (client: WebSocket, request) => {
    const base = workerBaseUrl(request.params.id)
    if (!base) {
      client.close(1008, "agent not found")
      return
    }
    const upstream = new WebSocket(`${base.replace(/^http/, "ws")}/dsh/api/remote.mux`)
    const queued: { data: WebSocket.RawData; binary: boolean }[] = []
    client.on("message", (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
      else queued.push({ data, binary })
    })
    upstream.on("open", () => {
      for (const frame of queued.splice(0)) upstream.send(frame.data, { binary: frame.binary })
    })
    upstream.on("message", (data, binary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary })
    })
    upstream.on("close", (code) => client.close(code === 1005 || code === 1006 ? 1011 : code))
    upstream.on("error", () => client.close(1011, "worker unavailable"))
    client.on("close", () => upstream.terminate())
  })

  app.route<{ Params: { id: string } }>({
    method: ["GET", "POST"],
    url: "/agents/:id/dsh/*",
    handler: async (request, reply) => {
      const base = workerBaseUrl(request.params.id)
      if (!base) return reply.code(404).send({ error: "agent not found" })
      // Keep the raw path and query: combo script URLs carry their file list in the query.
      const raw = request.raw.url ?? ""
      const path = raw.slice(raw.indexOf("/", "/agents/".length))
      const response = await fetch(`${base}${path}`, {
        method: request.method,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(request.method === "POST" ? { headers: { "content-type": "application/json" }, body: JSON.stringify(request.body ?? null) } : {}),
      })
      reply.code(response.status)
      for (const name of FORWARDED_HEADERS) {
        const value = response.headers.get(name)
        if (value) reply.header(name, value)
      }
      return reply.send(Buffer.from(await response.arrayBuffer()))
    },
  })
}
