import http from "node:http"
import type { BridgeConfig } from "./config"
import { oaiMessagesToContext, oaiSseChunk, oaiCompletionResponse } from "./translate"
import { buildModel, streamCompletion } from "./pi-ai"

export function createServer(config: BridgeConfig): http.Server {
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

    // Auth check
    if (config.authToken) {
      const auth = req.headers.authorization
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null
      if (token !== config.authToken) {
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Unauthorized" }))
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

        const stream = request.stream ?? false
        const context = oaiMessagesToContext(request.messages ?? [], request.tools)
        const piModel = buildModel(modelConfig)
        const options = {
          apiKey: modelConfig.apiKey,
          temperature: request.temperature,
          maxTokens: request.max_tokens ?? modelConfig.maxTokens,
        }

        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          })

          // Initial role chunk
          res.write(oaiSseChunk(modelId, { content: "" }, null))

          try {
            for await (const event of streamCompletion(piModel, context, options)) {
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
            for await (const event of streamCompletion(piModel, context, options)) {
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
