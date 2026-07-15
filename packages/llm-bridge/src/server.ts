import http from "node:http"
import type { BridgeConfig, BridgeModelConfig } from "./config"
import { oaiMessagesToContext, oaiSseChunk, oaiCompletionResponse } from "./translate"
import { buildModel, streamCompletion } from "./pi-ai"
import { streamAnthropicDirect, createAnthropicClient } from "./anthropic-direct"
import { authenticate, isModelAllowed, type ApiKeyEntry } from "./auth"
import { AnthropicTokenStore, parseOAuthCredentials } from "./anthropic-oauth"
import type { AssistantMessageEvent } from "@earendil-works/pi-ai"

// Token stores for models with OAuth — keyed by model id
const tokenStores = new Map<string, AnthropicTokenStore>()

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

export function createServer(config: BridgeConfig, apiKeys: Map<string, ApiKeyEntry>): http.Server {
  return http.createServer(async (req, res) => {
    // CORS (in case the web UI needs it)
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    // Auth check — if keys are configured, require valid Bearer token
    let authKey: ApiKeyEntry | null = null
    if (apiKeys.size > 0) {
      authKey = authenticate(req.headers.authorization, apiKeys)
      if (!authKey) {
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: { message: "Invalid or missing API key", type: "authentication_error" } }))
        return
      }
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`)

    // Health check
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true, models: Object.keys(config.models) }))
      return
    }

    // List models
    if (url.pathname === "/v1/models" && req.method === "GET") {
      const models = Object.values(config.models).map((m) => ({
        id: m.id,
        object: "model" as const,
        created: 0,
        owned_by: m.provider,
      }))
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: models }))
      return
    }

    // Chat completions
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      try {
        const body = await readBody(req)
        const request = JSON.parse(body)

        const modelId = request.model ?? config.defaultModel
        const modelConfig = config.models[modelId]
        if (!modelConfig) {
          res.writeHead(404, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: { message: `Model '${modelId}' not found`, type: "invalid_request_error" } }))
          return
        }

        // Check model access if auth is enabled
        if (authKey && !isModelAllowed(authKey, modelId)) {
          res.writeHead(403, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: { message: `Key is not allowed to access model '${modelId}'`, type: "permission_error" } }))
          return
        }

        const stream = request.stream ?? false
        const isOAuth = Boolean(modelConfig.oauthRefreshToken)
        const resolvedApiKey = await getApiKey(modelConfig)

        // For OAuth (Anthropic subscription), use direct SDK — bypasses pi-ai
        // For standard API keys, use pi-ai's stream()
        const eventIterator: AsyncIterable<AssistantMessageEvent> = isOAuth
          ? streamAnthropicDirect(createAnthropicClient(resolvedApiKey, modelConfig.baseUrl), {
              model: modelId,
              messages: request.messages ?? [],
              tools: request.tools,
              max_tokens: request.max_tokens ?? modelConfig.maxTokens,
              temperature: request.temperature,
            })
          : (() => {
              const context = oaiMessagesToContext(request.messages ?? [], request.tools)
              const piModel = buildModel(modelConfig)
              const options = {
                apiKey: resolvedApiKey,
                temperature: request.temperature,
                maxTokens: request.max_tokens ?? modelConfig.maxTokens,
              }
              return streamCompletion(piModel, context, options)
            })()

        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          })

          // Initial role chunk
          res.write(oaiSseChunk(modelId, { content: "" }, null))

          try {
            for await (const event of eventIterator) {
              if (event.type === "text_delta") {
                res.write(oaiSseChunk(modelId, { content: event.delta }, null))
              } else if (event.type === "toolcall_end") {
                const tc = event.toolCall
                res.write(oaiSseChunk(modelId, {
                  tool_calls: [{
                    index: event.contentIndex,
                    id: tc.id,
                    type: "function",
                    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                  }],
                }, null))
              } else if (event.type === "done") {
                res.write(oaiSseChunk(modelId, {}, mapFinishReason(event.reason)))
              } else if (event.type === "error") {
                res.write(oaiSseChunk(modelId, {}, "error"))
              }
            }
          } catch (err) {
            console.error("[bridge] stream error:", err)
            res.write(oaiSseChunk(modelId, {}, "error"))
          }

          res.write("data: [DONE]\n\n")
          res.end()
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
            res.writeHead(500, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ error: { message: String(err), type: "server_error" } }))
            return
          }

          const response = oaiCompletionResponse(modelId, text, toolCalls, finishReason, usage)
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify(response))
        }
      } catch (err) {
        console.error("[bridge] request error:", err)
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: { message: String(err), type: "invalid_request_error" } }))
      }
      return
    }

    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "Not found" }))
  })
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

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ""
    req.on("data", (chunk) => { data += chunk })
    req.on("end", () => resolve(data))
    req.on("error", reject)
  })
}
