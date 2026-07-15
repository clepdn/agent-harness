import Fastify, { type FastifyInstance } from "fastify"
import type { BridgeConfig, BridgeModelConfig } from "./config"
import { oaiMessagesToContext, oaiSseChunk, oaiCompletionResponse } from "./translate"
import { buildModel, streamCompletion } from "./pi-ai"
import { streamAnthropicDirect, createAnthropicClient } from "./anthropic-direct"
import { authenticate, isModelAllowed, type ApiKeyEntry } from "./auth"
import { AnthropicTokenStore, parseOAuthCredentials } from "./anthropic-oauth"
import { handleAntigravityCompletion } from "./antigravity"
import { handleCodexCompletion } from "./codex"
import { getProviders, getModels } from "@earendil-works/pi-ai"
import type { AssistantMessageEvent } from "@earendil-works/pi-ai"

// Token stores for models with OAuth — keyed by model id
const tokenStores = new Map<string, AnthropicTokenStore>()

// ── Model routing ─────────────────────────────────────────────────────────────

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

/**
 * Discover models from custom providers and merge with pi-ai's registry.
 * Called on startup.
 */
export async function discoverModels(config: BridgeConfig): Promise<void> {
  // 1. Add models from pi-ai's built-in registry
  for (const provider of getProviders()) {
    for (const model of getModels(provider)) {
      // Only add if not already present (custom providers take priority)
      if (!config.models[model.id]) {
        config.models[model.id] = {
          id: model.id,
          name: model.name,
          provider,
          baseUrl: model.baseUrl,
          apiKey: "", // pi-ai handles key resolution from env
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          reasoning: model.reasoning,
        }
      }
    }
  }

  // 2. Discover models from custom providers with base_url + api_key
  for (const provider of config.providers) {
    if (provider.api_key && provider.base_url) {
      try {
        const resp = await fetch(`${provider.base_url}/models`, {
          headers: { Authorization: `Bearer ${provider.api_key}` },
        })
        if (resp.ok) {
          const data = await resp.json() as { data?: Array<{ id: string; context_length?: number }> }
          for (const m of data.data ?? []) {
            config.models[m.id] = {
              id: m.id,
              name: m.id,
              provider: provider.name,
              baseUrl: provider.base_url,
              apiKey: provider.api_key,
              ...(m.context_length ? { contextWindow: m.context_length } : {}),
            }
          }
          console.log(`[bridge] discovered ${data.data?.length ?? 0} models from ${provider.name}`)
        }
      } catch (err) {
        console.error(`[bridge] failed to fetch models from ${provider.name}:`, err)
      }
    }

    // 3. Add OAuth providers (Anthropic subscription)
    if (provider.oauth_refresh_token) {
      // Claude models via OAuth — these use the direct Anthropic SDK
      const claudeModels = [
        "claude-sonnet-4-5-20250514",
        "claude-opus-4-20250515",
        "claude-haiku-4-20250414",
      ]
      for (const id of claudeModels) {
        config.models[id] = {
          id,
          name: id,
          provider: "anthropic-oauth",
          apiKey: "",
          oauthRefreshToken: provider.oauth_refresh_token,
        }
      }
      console.log(`[bridge] added ${claudeModels.length} Anthropic OAuth models from ${provider.name}`)
    }
  }

  console.log(`[bridge] total models in registry: ${Object.keys(config.models).length}`)
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
    models: Object.keys(config.models).length,
  }))

  // List all models
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

    // Route to custom backends based on model name
    if (isAntigravityModel(modelId)) {
      return handleAntigravityCompletion(req, reply)
    }
    if (isCodexModel(modelId)) {
      const result = await handleCodexCompletion(body)
      return reply.code(result.status).headers(result.headers).send(result.body)
    }

    // Look up model in registry
    const modelConfig = config.models[modelId]
    if (!modelConfig) {
      return reply.code(404).send({ error: { message: `Model '${modelId}' not found`, type: "invalid_request_error" } })
    }

    const stream = body.stream ?? false
    const isOAuth = Boolean(modelConfig.oauthRefreshToken)
    const resolvedApiKey = await getApiKey(modelConfig)

    // For OAuth (Anthropic subscription), use direct SDK — bypasses pi-ai
    // For everything else, use pi-ai's stream()
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
