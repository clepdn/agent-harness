// Admin API + UI, mounted at /admin.
//
// Gated on the "admin" capability rather than mere possession of a valid key:
// every coral agent holds a key with `allowedModels: ["*"]`, and none of them
// should be able to re-auth the accounts they run on.
//
// Note the deployment this sits in: nginx proxies all of :4040 to the public
// internet, so these routes are reachable from anywhere. The capability check
// is the only thing in front of them.

import type { FastifyInstance } from "fastify"
import type { BridgeConfig } from "./config"
import { authenticate, hasCap, type ApiKeyEntry } from "./auth"
import fastifyStatic from "@fastify/static"
import { ADMIN_DIST_DIR, adminPage, hasAdminBuild } from "./admin-shell"
import {
  cancelLogin,
  getSession,
  logout,
  providerStatus,
  publicSession,
  reapSessions,
  registerProvider,
  resolveAuthPath,
  startLogin,
  startSessionReaper,
  type LoginProviderId,
} from "./oauth-login"

const ADMIN_CAP = "admin"
const LOGIN_PROVIDERS: LoginProviderId[] = ["anthropic", "codex"]

function isLoginProvider(value: string): value is LoginProviderId {
  return (LOGIN_PROVIDERS as string[]).includes(value)
}

export function registerAdminRoutes(
  app: FastifyInstance,
  config: BridgeConfig,
  apiKeys: Map<string, ApiKeyEntry>,
  refreshModels: () => Promise<void>,
): void {
  /**
   * Resolve the caller's key, or send the error and return null. Fails closed
   * when no keys are configured at all: an open bridge is loopback-only (see
   * index.ts), but "no auth configured" must never mean "everyone is admin".
   */
  function requireAdmin(req: any, reply: any): ApiKeyEntry | null {
    if (apiKeys.size === 0) {
      reply.code(403).send({
        error: { message: "Admin requires an API key with the 'admin' cap; this bridge has no keys configured", type: "permission_error" },
      })
      return null
    }
    const key = authenticate(req.headers.authorization, apiKeys)
    if (!key) {
      reply.code(401).send({ error: { message: "Invalid or missing API key", type: "authentication_error" } })
      return null
    }
    if (!hasCap(key, ADMIN_CAP)) {
      reply.code(403).send({ error: { message: "Key lacks the 'admin' cap", type: "permission_error" } })
      return null
    }
    return key
  }

  const reaper = startSessionReaper()
  app.addHook("onClose", async () => clearInterval(reaper))

  if (hasAdminBuild()) {
    app.register(fastifyStatic, {
      root: `${ADMIN_DIST_DIR}/assets`,
      prefix: "/admin/assets/",
      decorateReply: false,
      cacheControl: false,
    })
  }

  // The shell is not secret — it holds no data and prompts for a key on load.
  // Everything under /admin/api is what actually needs guarding.
  app.get("/admin", async (_req, reply) => {
    if (!hasAdminBuild()) {
      return reply.code(503).send({ error: "admin UI is not built yet; run `npm run build:admin` first" })
    }
    return reply.type("text/html; charset=utf-8").send(adminPage())
  })

  app.get("/admin/api/providers", async (req: any, reply: any) => {
    if (!requireAdmin(req, reply)) return
    reapSessions()
    return reply.send({ providers: LOGIN_PROVIDERS.map((p) => providerStatus(config, p)) })
  })

  app.post("/admin/api/login/:provider", async (req: any, reply: any) => {
    if (!requireAdmin(req, reply)) return
    const provider = String(req.params?.provider ?? "")
    if (!isLoginProvider(provider)) {
      return reply.code(404).send({ error: { message: `Unknown login provider '${provider}'`, type: "invalid_request_error" } })
    }

    try {
      const session = await startLogin(config, provider, async () => {
        registerProvider(config, provider, resolveAuthPath(config, provider))
        // New credentials mean new servable models, and discovery otherwise
        // only runs at startup — without this the login appears to do nothing.
        await refreshModels()
      })
      return reply.send(session)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[bridge] failed to start ${provider} login: ${message}`)
      return reply.code(502).send({ error: { message, type: "server_error" } })
    }
  })

  app.get("/admin/api/session/:id", async (req: any, reply: any) => {
    if (!requireAdmin(req, reply)) return
    reapSessions()
    const session = getSession(String(req.params?.id ?? ""))
    if (!session) return reply.code(404).send({ error: { message: "Unknown login session", type: "invalid_request_error" } })
    return reply.send(publicSession(session))
  })

  app.post("/admin/api/session/:id/code", async (req: any, reply: any) => {
    if (!requireAdmin(req, reply)) return
    const session = getSession(String(req.params?.id ?? ""))
    if (!session) return reply.code(404).send({ error: { message: "Unknown login session", type: "invalid_request_error" } })
    if (session.kind !== "paste") {
      return reply.code(400).send({ error: { message: `The ${session.provider} flow does not take a pasted code`, type: "invalid_request_error" } })
    }
    if (session.status !== "awaiting_code") {
      return reply.code(409).send({ error: { message: `Session is ${session.status}`, type: "invalid_request_error" } })
    }

    const code = typeof req.body?.code === "string" ? req.body.code.trim() : ""
    if (!code) return reply.code(400).send({ error: { message: "Body must include a non-empty 'code'", type: "invalid_request_error" } })

    session.status = "polling"
    session.submitCode?.(code)
    return reply.send(publicSession(session))
  })

  app.delete("/admin/api/session/:id", async (req: any, reply: any) => {
    if (!requireAdmin(req, reply)) return
    const cancelled = await cancelLogin(String(req.params?.id ?? ""))
    if (!cancelled) return reply.code(404).send({ error: { message: "Unknown login session", type: "invalid_request_error" } })
    return reply.code(204).send()
  })

  app.post("/admin/api/logout/:provider", async (req: any, reply: any) => {
    if (!requireAdmin(req, reply)) return
    const provider = String(req.params?.provider ?? "")
    if (!isLoginProvider(provider)) {
      return reply.code(404).send({ error: { message: `Unknown login provider '${provider}'`, type: "invalid_request_error" } })
    }
    try {
      logout(config, provider)
      return reply.send(providerStatus(config, provider))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: { message, type: "server_error" } })
    }
  })
}
