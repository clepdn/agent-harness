import { createReadStream, existsSync, statSync } from "node:fs"
import path from "node:path"
import type { FastifyReply, FastifyRequest } from "fastify"
import { configSchema, type Plugin } from "@nano/plugins"
import { CONTROL_STATIC_UI, type ControlStaticUi } from "@nano/control-api"

export const WEB_UI_CACHE_CONTROL = "no-store, max-age=0, must-revalidate"

export function setWebUiCacheHeaders(res: { setHeader(name: string, value: string): unknown }): void {
  res.setHeader("cache-control", WEB_UI_CACHE_CONTROL)
  res.setHeader("pragma", "no-cache")
  res.setHeader("expires", "0")
}


const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

type StaticUiConfig = { directory: string; enabled: boolean }

export function staticUiPlugin(options: { directory: string; enabled?: boolean }): Plugin.Object<StaticUiConfig> {
  const Config = configSchema((raw: unknown): StaticUiConfig => {
    let directory = options.directory
    let enabled = options.enabled ?? true
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      if ("directory" in raw && typeof raw.directory === "string") directory = raw.directory
      if ("enabled" in raw && typeof raw.enabled === "boolean") enabled = raw.enabled
    }
    return { directory, enabled }
  })
  return {
    name: "control.static-ui",
    provide: [CONTROL_STATIC_UI.name],
    Config,
    apply(ctx, config) {
      const service: ControlStaticUi = {
        enabled: config.enabled,
        directory: path.resolve(config.directory),
        async serve(relativePath, reply) {
          if (!config.enabled) return reply.code(404).send({ error: "not found" })
          const requested = relativePath ? decodeURIComponent(relativePath) : "index.html"
          const file = path.resolve(config.directory, requested)
          const root = path.resolve(config.directory)
          if (file !== root && !file.startsWith(`${root}${path.sep}`)) return reply.code(404).send({ error: "not found" })
          if (!existsSync(file) || !statSync(file).isFile()) {
            if (relativePath) return reply.code(404).send({ error: "not found" })
            return reply.code(503).send({ error: "web ui is not built yet. run `npm run build:web` first." })
          }
          setWebUiCacheHeaders(reply.raw)
          reply.type(CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream")
          return reply.send(createReadStream(file))
        },
      }
      ctx.provide(CONTROL_STATIC_UI.name, service)
    },
  }
}

export function staticUiRoute(app: { get(path: string, handler: (request: FastifyRequest, reply: FastifyReply) => unknown): unknown }, ui?: ControlStaticUi): void {
  app.get("/ui", async (_request, reply) => {
    const current = ui
    if (!current) return reply.code(503).send({ error: "web ui is not built yet. run `npm run build:web` first." })
    return current.serve(undefined, reply)
  })
  app.get("/ui/*", async (request, reply) => {
    const current = ui
    if (!current) return reply.code(503).send({ error: "web ui is not built yet. run `npm run build:web` first." })
    const params = request.params as { "*"?: string }
    return current.serve(params["*"], reply)
  })
}
