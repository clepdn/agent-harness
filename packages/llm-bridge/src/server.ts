import Fastify, { type FastifyInstance } from "fastify"
import type { BridgeConfig } from "./config"
import { authenticate, isModelAllowed, type ApiKeyEntry } from "./auth"
import { handleAntigravityCompletion } from "./antigravity"
import { handleCodexCompletion } from "./codex"

// ── Model routing ─────────────────────────────────────────────────────────────

function isAntigravityModel(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  return lower.startsWith("gemini-") || lower.startsWith("agy-")
}

function isCodexModel(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  return lower.startsWith("gpt-") || lower.startsWith("o3-") || lower.startsWith("o4-") || lower.startsWith("codex-")
}

/**
 * Fetch available models from the upstream API.
 */
export async function fetchUpstreamModels(baseUrl: string, apiKey: string) {
  try {
    const resp = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!resp.ok) {
      console.error(`[bridge] failed to fetch models from upstream: ${resp.status}`)
      return []
    }
    const data = await resp.json() as { data?: Array<{ id: string; context_length?: number; owned_by?: string }> }
    return data.data ?? []
  } catch (err) {
    console.error("[bridge] error fetching upstream models:", err)
    return []
  }
}

export function createServer(config: BridgeConfig, apiKeys: Map<string, ApiKeyEntry>): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024 * 1024,
  })

  // CORS
  app.options("/*", async (_req, reply) => {
    reply.header("Access-Control-Allow-Origin", "*")
    reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization")
    reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    return reply.code(204).send()
  })

  // Health check
  app.get("/health", async () => ({
    ok: true,
    upstream: config.upstreamBaseUrl,
    models: config.models.map((m) => m.id),
  }))

  // List models — merges upstream models with antigravity/codex
  app.get("/v1/models", async () => {
    const upstreamModels = config.models.map((m) => ({
      id: m.id,
      object: "model" as const,
      created: 0,
      owned_by: m.owned_by ?? "upstream",
    }))
    return { object: "list", data: upstreamModels }
  })

  // Unified chat completions — routes based on model name
  app.post("/v1/chat/completions", async (req: any, reply: any) => {
    // Auth check
    let authKey: ApiKeyEntry | null = null
    if (apiKeys.size > 0) {
      authKey = authenticate(req.headers.authorization, apiKeys)
      if (!authKey) {
        return reply.code(401).send({ error: { message: "Invalid or missing API key", type: "authentication_error" } })
      }
    }

    const body = req.body || {}
    const modelId = body.model ?? ""

    // Check model access if auth is enabled
    if (authKey && !isModelAllowed(authKey, modelId)) {
      return reply.code(403).send({ error: { message: `Key is not allowed to access model '${modelId}'`, type: "permission_error" } })
    }

    // Route to sub-bridge backends based on model name
    if (isAntigravityModel(modelId)) {
      return handleAntigravityCompletion(req, reply)
    }
    if (isCodexModel(modelId)) {
      const result = await handleCodexCompletion(body)
      return reply.code(result.status).headers(result.headers).send(result.body)
    }

    // Default: transparent proxy to upstream API
    const upstreamUrl = `${config.upstreamBaseUrl}/chat/completions`
    const upstreamHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.upstreamApiKey}`,
    }

    try {
      const upstreamResp = await fetch(upstreamUrl, {
        method: "POST",
        headers: upstreamHeaders,
        body: JSON.stringify(body),
      })

      // Forward status code
      reply.code(upstreamResp.status)

      // Forward relevant headers
      const contentType = upstreamResp.headers.get("content-type")
      if (contentType) reply.header("Content-Type", contentType)

      // Stream or buffer the response
      if (body.stream && upstreamResp.body) {
        // Stream SSE chunks back
        const reader = upstreamResp.body.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            reply.raw.write(value)
          }
        } finally {
          reader.releaseLock()
        }
        reply.raw.end()
        return
      } else {
        const text = await upstreamResp.text()
        return reply.send(text)
      }
    } catch (err) {
      console.error("[bridge] upstream proxy error:", err)
      return reply.code(502).send({ error: { message: `Upstream error: ${err}`, type: "server_error" } })
    }
  })

  return app
}
