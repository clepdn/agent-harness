import Fastify, { type FastifyInstance } from "fastify"
import type { BridgeConfig, BridgeModelConfig } from "./config"
import { oaiMessagesToContext, oaiSseChunk, oaiCompletionResponse } from "./translate"
import { buildModel, streamCompletion } from "./pi-ai"
import { streamAnthropicDirect, createAnthropicClient } from "./anthropic-direct"
import { authenticate, isModelAllowed, type ApiKeyEntry } from "./auth"
import { AnthropicTokenStore, parseOAuthCredentials } from "./anthropic-oauth"
import { handleAntigravityCompletion } from "./antigravity"
import { handleCodexCompletion } from "./codex"
import type { AssistantMessageEvent } from "@earendil-works/pi-ai"

// Token stores for models with OAuth — keyed by model id
const tokenStores = new Map<string, AnthropicTokenStore>()

// ── Model routing ─────────────────────────────────────────────────────────────
// Models are routed to the appropriate backend based on their name.

function isAntigravityModel(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  return lower.startsWith("gemini-") || lower.startsWith("agy-")
}

function isCodexModel(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  return lower.startsWith("gpt-") || lower.startsWith("o3-") || lower.startsWith("o4-") || lower.startsWith("codex-")
}

function getApiKey(modelConfig: BridgeModelConfig): Promise<string> {
  if (modelConfig.oauthRefreshToken) {
    let store = tokenStores.get(modelConfig.id)
    if (!store) {
      store = new AnthropicTokenStore(parseOAuthCredentials(modelConfig.oauthRefreshToken) ?? undefined)
      tokenStores.set(modelConfig.id, store)
    }
    return store.getAccessToken()
  }
  return Promise.resolve(modelConfig.apiKey)
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
  app.get("/health", async () => {
    return { ok: true, models: Object.keys(config.models) }
  })

  // List models
  app.get("/v1/models", async () => {
    const models = Object.values(config.models).map((m) => ({
      id: m.id,
      object: "model" as const,
      created: 0,
      owned_by: m.provider,
    }))
    return { object: "list", data: models }
  })

  // Unified chat completions — routes based on model name
  app.post("/v1/chat/completions", async (req: any, reply: any) => {
    // Auth check — if keys are configured, require valid Bearer token
    let authKey: ApiKeyEntry | null = null
    if (apiKeys.size > 0) {
      authKey = authenticate(req.headers.authorization, apiKeys)
      if (!authKey) {
        return reply.code(401).send({ error: { message: "Invalid or missing API key", type: "authentication_error" } })
      }
    }

    const body = req.body || {}
    const modelId = body.model ?? config.defaultModel

    // Route to sub-bridge backends based on model name
    if (isAntigravityModel(modelId)) {
      return handleAntigravityCompletion(req, reply)
    }
    if (isCodexModel(modelId)) {
      const result = await handleCodexCompletion(body)
      return reply.code(result.status).headers(result.headers).send(result.body)
    }

    // Pi-ai / Anthropic direct handler
    const modelConfig = config.models[modelId]
    if (!modelConfig) {
      return reply.code(404).send({ error: { message: `Model '${modelId}' not found`, type: "invalid_request_error" } })
    }

    // Check model access if auth is enabled
    if (authKey && !isModelAllowed(authKey, modelId)) {
      return reply.code(403).send({ error: { message: `Key is not allowed to access model '${modelId}'`, type: "permission_error" } })
    }

    const stream = body.stream ?? false
    const isOAuth = Boolean(modelConfig.oauthRefreshToken)
    const resolvedApiKey = await getApiKey(modelConfig)

    // For OAuth (Anthropic subscription), use direct SDK — bypasses pi-ai
    // For standard API keys, use pi-ai's stream()
    const eventIterator: AsyncIterable<AssistantMessageEvent> = isOAuth
      ? streamAnthropicDirect(createAnthropicClient(resolvedApiKey, modelConfig.baseUrl), {
          model: modelId,
          messages: body.messages ?? [],
          tools: body.tools,
          max_tokens: body.max_tokens ?? modelConfig.maxTokens,
          temperature: body.temperature,
        })
      : (() => {
          const context = oaiMessagesToContext(body.messages ?? [], body.tools)
          const piModel = buildModel(modelConfig)
          const options = {
            apiKey: resolvedApiKey,
            temperature: body.temperature,
            maxTokens: body.max_tokens ?? modelConfig.maxTokens,
          }
          return streamCompletion(piModel, context, options)
        })()

    if (stream) {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })

      // Initial role chunk
      reply.raw.write(oaiSseChunk(modelId, { content: "" }, null))

      try {
        for await (const event of eventIterator) {
          if (event.type === "text_delta") {
            reply.raw.write(oaiSseChunk(modelId, { content: event.delta }, null))
          } else if (event.type === "toolcall_end") {
            const tc = event.toolCall
            reply.raw.write(oaiSseChunk(modelId, {
              tool_calls: [{
                index: event.contentIndex,
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
              }],
            }, null))
          } else if (event.type === "done") {
            reply.raw.write(oaiSseChunk(modelId, {}, mapFinishReason(event.reason)))
          } else if (event.type === "error") {
            reply.raw.write(oaiSseChunk(modelId, {}, "error"))
          }
        }
      } catch (err) {
        console.error("[bridge] stream error:", err)
        reply.raw.write(oaiSseChunk(modelId, {}, "error"))
      }

      reply.raw.write("data: [DONE]\n\n")
      reply.raw.end()
      return
    } else {
      // Non-streaming
      let text = ""
      const toolCalls: Array<{ id: string; name: string; arguments: string }> = []
      let finishReason = "stop"
      let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

      try {
        for await (const event of eventIterator) {
          if (event.type === "text_delta") {
            text += event.delta
          } else if (event.type === "toolcall_end") {
            toolCalls.push({
              id: event.toolCall.id,
              name: event.toolCall.name,
              arguments: JSON.stringify(event.toolCall.arguments),
            })
          } else if (event.type === "done") {
            finishReason = mapFinishReason(event.reason)
            const u = event.message.usage
            usage = {
              prompt_tokens: u.input,
              completion_tokens: u.output,
              total_tokens: u.totalTokens,
            }
          }
        }
      } catch (err) {
        console.error("[bridge] completion error:", err)
        return reply.code(500).send({ error: { message: String(err), type: "server_error" } })
      }

      const response = oaiCompletionResponse(modelId, text, toolCalls, finishReason, usage)
      return reply.send(response)
    }
  })

  return app
}

function mapFinishReason(reason: string): string {
  switch (reason) {
    case "stop": return "stop"
    case "length": return "length"
    case "toolUse": return "tool_calls"
    case "error": return "error"
    case "aborted": return "abort"
    default: return "stop"
  }
}
