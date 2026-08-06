import Fastify, { type FastifyInstance } from "fastify"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import type { BridgeConfig, BridgeModelConfig } from "./config"
import { oaiMessagesToContext, oaiSseChunk, oaiSseUsageChunk, oaiCompletionResponse } from "./translate"
import { buildModel, streamCompletion } from "./pi-ai"
import { streamAnthropicDirect, createAnthropicClient } from "./anthropic-direct"
import { authenticate, isModelAllowed, type ApiKeyEntry } from "./auth"
import { createAnthropicStore, type TokenStore } from "./anthropic-oauth"
import { registerAdminRoutes } from "./admin"
import { NON_ANTHROPIC_AUTH_PROVIDERS } from "./oauth-login"
import { handleAntigravityCompletion } from "./antigravity"
import { handleCodexCompletion } from "./codex"
import { resolveProviderName, hasUsageSupport, getUsageForModel } from "./usage"
import { recordCodexUsage } from "./codex-usage"
import { capImagesForUmans, isUmansModel, UMANS_MAX_IMAGES } from "./umans"
import { getProviders, getModels, getEnvApiKey } from "@earendil-works/pi-ai/compat"
import type { AssistantMessageEvent } from "@earendil-works/pi-ai"

// OAuth token stores, keyed by auth file path so every model backed by the same
// credential file shares one store (and one refresh).
const tokenStores = new Map<string, TokenStore>()

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
 * One store per credential file, shared by everything that needs a token.
 * FileTokenStore serialises refreshes through an internal chain, so a second
 * store over the same file would defeat that and let two refreshes race —
 * which matters because model discovery re-runs after every admin login, while
 * agents are still serving traffic.
 */
function getAnthropicStore(authPath: string): TokenStore {
  let store = tokenStores.get(authPath)
  if (!store) {
    store = createAnthropicStore({ authPath })
    tokenStores.set(authPath, store)
  }
  return store
}

function getApiKey(modelConfig: BridgeModelConfig): Promise<string> {
  if (modelConfig.authPath) {
    return getAnthropicStore(modelConfig.authPath).getAccessToken()
  }
  return Promise.resolve(modelConfig.apiKey)
}

// ── Provider credential detection ─────────────────────────────────────────────
// pi-ai's registry advertises models for ~35 providers, but most are unusable
// without credentials (OpenRouter alone lists 269 models). To keep /v1/models
// honest — only list models we can actually serve — a registry provider's models
// are only registered when we can find credentials for it: an explicit bridge
// key, a pi-ai-resolvable env key (incl. ADC/Bedrock/OAuth env tokens), or a
// special custom provider the bridge routes those models through.

const HOME = os.homedir()

// Registry providers whose models the bridge reroutes to a special custom
// provider instead of pi-ai's env-key path, mapped to that provider's name.
const SPECIAL_ROUTING: Record<string, "antigravity" | "codex"> = {
  google: "antigravity",
  "google-vertex": "antigravity",
  openai: "codex",
  "openai-codex": "codex",
}

function codexReachable(config: BridgeConfig): boolean {
  if (config.providers["codex"]?.auth_path) return true
  if (process.env.CODEX_AUTH_PATH) return true
  // codex's handler falls back to ~/.codex/auth.json
  return fs.existsSync(path.join(HOME, ".codex", "auth.json"))
}

function antigravityReachable(config: BridgeConfig): boolean {
  const ag = config.providers["antigravity"]
  if (ag && (ag.refresh_token || ag.client_id)) return true
  if (process.env.ANTIGRAVITY_REFRESH_TOKEN) return true
  // antigravity's loader falls back to ~/.gemini/antigravity-cli/antigravity-oauth-token
  return fs.existsSync(path.join(HOME, ".gemini", "antigravity-cli", "antigravity-oauth-token"))
}

/**
 * Can we actually serve a pi-ai registry provider's models? Returns true when an
 * explicit bridge key, a pi-ai-resolvable env key, or a configured special
 * custom provider backs it.
 */
function providerHasCredentials(config: BridgeConfig, providerName: string): boolean {
  // 1. Explicit key in bridge config for this provider name
  if (config.providers[providerName]?.api_key) return true
  // 2. pi-ai can resolve a key from env (incl. ADC/Bedrock/OAuth env tokens)
  if (getEnvApiKey(providerName)) return true
  // 3. Models rerouted to a configured special custom provider
  switch (SPECIAL_ROUTING[providerName]) {
    case "antigravity":
      return antigravityReachable(config)
    case "codex":
      return codexReachable(config)
    default:
      return false
  }
}

// ── Anthropic model discovery ───────────────────────────────────────────────────

const ANTHROPIC_VERSION = "2023-06-01"
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20"

/**
 * Fetch the list of available models from Anthropic's API using an OAuth access
 * token. Paginates via `after_id`. No hardcoded model list — whatever the
 * account can see is what gets registered.
 */
async function fetchAnthropicModels(
  accessToken: string,
  baseUrl?: string,
): Promise<Array<{ id: string; name: string }>> {
  const base = baseUrl && baseUrl.trim() ? baseUrl.replace(/\/+$/, "") : "https://api.anthropic.com"
  const out: Array<{ id: string; name: string }> = []
  let afterId: string | undefined

  for (let page = 0; page < 20; page++) {
    const url = new URL(`${base}/v1/models`)
    url.searchParams.set("limit", "1000")
    if (afterId) url.searchParams.set("after_id", afterId)

    const resp = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": ANTHROPIC_OAUTH_BETA,
        "user-agent": "nano-llm-bridge",
      },
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => "")
      throw new Error(`Anthropic /v1/models failed (${resp.status}): ${body.slice(0, 200)}`)
    }

    const data = (await resp.json()) as {
      data?: Array<{ id: string; display_name?: string }>
      has_more?: boolean
      last_id?: string
    }
    for (const m of data.data ?? []) out.push({ id: m.id, name: m.display_name ?? m.id })

    if (!data.has_more || !data.last_id) break
    afterId = data.last_id
  }

  return out
}

/**
 * Discover models from custom providers and merge with pi-ai's registry.
 * Called on startup.
 */
export async function discoverModels(config: BridgeConfig): Promise<void> {
  // 1. Add models from pi-ai's built-in registry — but only for providers we
  //    actually have credentials for, so /v1/models doesn't advertise hundreds
  //    of unusable models (e.g. OpenRouter's 269).
  const skipped: string[] = []
  for (const provider of getProviders()) {
    if (!providerHasCredentials(config, provider)) {
      skipped.push(provider)
      continue
    }
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
  if (skipped.length) {
    console.log(`[bridge] skipping ${skipped.length} registry provider(s) without credentials: ${skipped.join(", ")}`)
  }

  // 2. Discover models from custom providers with base_url + api_key
  for (const [providerName, provider] of Object.entries(config.providers)) {
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
              provider: providerName,
              baseUrl: provider.base_url,
              apiKey: provider.api_key,
              ...(m.context_length ? { contextWindow: m.context_length } : {}),
            }
          }
          console.log(`[bridge] discovered ${data.data?.length ?? 0} models from ${providerName}`)
        }
      } catch (err) {
        console.error(`[bridge] failed to fetch models from ${providerName}:`, err)
      }
    }

    // 3. Anthropic subscription (OAuth) — discover models from Anthropic's API
    //    instead of hardcoding them. Credentials come from the provider's
    //    auth.json (auth_path); tokens refresh + rotate in place.
    //    codex and antigravity also carry an auth_path, but theirs holds a
    //    different credential shape and their models come from elsewhere.
    if (provider.auth_path && !NON_ANTHROPIC_AUTH_PROVIDERS.has(providerName)) {
      try {
        const store = getAnthropicStore(provider.auth_path)
        const token = await store.getAccessToken()
        const models = await fetchAnthropicModels(token, provider.base_url)
        for (const m of models) {
          config.models[m.id] = {
            id: m.id,
            name: m.name,
            provider: "anthropic-oauth",
            apiKey: "",
            authPath: provider.auth_path,
          }
        }
        console.log(`[bridge] discovered ${models.length} Anthropic OAuth models from ${providerName}`)
      } catch (err) {
        console.error(
          `[bridge] failed to discover Anthropic models from ${providerName}:`,
          err instanceof Error ? err.message : err,
        )
      }
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

  // Admin UI + subscription logins. Serialized re-discovery: two logins
  // finishing at once would otherwise interleave writes into config.models.
  let discovery: Promise<void> = Promise.resolve()
  registerAdminRoutes(app, config, apiKeys, () => {
    discovery = discovery.catch(() => {}).then(() => discoverModels(config))
    return discovery
  })

  // List models the caller is authorized to use. When API keys are configured,
  // a valid key is required (401 otherwise, matching OpenAI/Anthropic) and only
  // the models that key is scoped for are returned.
  app.get("/v1/models", async (req: any, reply: any) => {
    let authKey: ApiKeyEntry | null = null
    if (apiKeys.size > 0) {
      authKey = authenticate(req.headers.authorization, apiKeys)
      if (!authKey) {
        return reply.code(401).send({ error: { message: "Invalid or missing API key", type: "authentication_error" } })
      }
    }

    const models = Object.values(config.models)
      // Only serve models this key is scoped for. Open mode (no keys) sees all.
      .filter((m) => !authKey || isModelAllowed(authKey, m.id))
      .map((m) => ({
        id: m.id,
        object: "model" as const,
        created: 0,
        owned_by: m.provider,
        // Passthrough of the provider's context window so clients (e.g. nano's
        // status display) can compute a context-usage percentage.
        ...(m.contextWindow ? { context_length: m.contextWindow } : {}),
      }))
    return reply.send({ object: "list", data: models })
  })

  // Provider usage — normalized "budget consumed" for the provider backing a
  // model. Auth mirrors chat completions. See usage.ts / umans.ts.
  app.get("/v1/usage", async (req: any, reply: any) => {
    let authKey: ApiKeyEntry | null = null
    if (apiKeys.size > 0) {
      authKey = authenticate(req.headers.authorization, apiKeys)
      if (!authKey) {
        return reply.code(401).send({ error: { message: "Invalid or missing API key", type: "authentication_error" } })
      }
    }

    const modelId = (req.query?.model ?? "") as string
    if (!modelId) {
      return reply.code(400).send({ error: { message: "query param 'model' is required", type: "invalid_request_error" } })
    }

    if (authKey && !isModelAllowed(authKey, modelId)) {
      return reply.code(403).send({ error: { message: `Key is not allowed to access model '${modelId}'`, type: "permission_error" } })
    }

    const providerName = resolveProviderName(config, modelId)
    if (!providerName) {
      return reply.code(404).send({ error: { message: `Model '${modelId}' not found`, type: "invalid_request_error" } })
    }

    if (!hasUsageSupport(providerName)) {
      return reply.code(501).send({ available: false, provider: providerName, reason: "usage not implemented for this provider" })
    }

    const usage = await getUsageForModel(config, providerName, modelId)
    if (!usage) {
      return reply.code(502).send({ available: false, provider: providerName, reason: "usage fetch failed" })
    }

    return reply.send({ available: true, provider: providerName, ...usage })
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
      // Set env vars from provider config (antigravity reads these at runtime)
      const agProvider = config.providers["antigravity"]
      if (agProvider) {
        if (agProvider.client_id) process.env.ANTIGRAVITY_CLIENT_ID = agProvider.client_id
        if (agProvider.client_secret) process.env.ANTIGRAVITY_CLIENT_SECRET = agProvider.client_secret
        if (agProvider.refresh_token) process.env.ANTIGRAVITY_REFRESH_TOKEN = agProvider.refresh_token
        if (agProvider.project_id) process.env.ANTIGRAVITY_PROJECT_ID = agProvider.project_id
        if (agProvider.binary_path) process.env.ANTIGRAVITY_BINARY_PATH = agProvider.binary_path
      }
      return handleAntigravityCompletion(req, reply)
    }
    if (isCodexModel(modelId)) {
      const codexProvider = config.providers["codex"]
      const result = await handleCodexCompletion(body, codexProvider)
      // Push-model usage: cache the latest rate-limit snapshot from the
      // upstream x-codex-* headers so /v1/usage can serve it.
      if (result.rateLimitHeaders) recordCodexUsage("codex", result.rateLimitHeaders)
      return reply.code(result.status).headers(result.headers).send(result.body)
    }

    // Look up model in registry
    const modelConfig = config.models[modelId]
    if (!modelConfig) {
      return reply.code(404).send({ error: { message: `Model '${modelId}' not found`, type: "invalid_request_error" } })
    }

    const stream = body.stream ?? false
    const isOAuth = Boolean(modelConfig.authPath)
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
          // umans corner: the upstream rejects a request carrying more than
          // UMANS_MAX_IMAGES images, so keep only the most recent ones.
          let messages = body.messages ?? []
          if (isUmansModel(modelConfig)) {
            const capped = capImagesForUmans(messages)
            if (capped.dropped > 0) {
              console.log(
                `[bridge] umans: dropped ${capped.dropped} image(s) over the ${UMANS_MAX_IMAGES}-image cap`,
              )
            }
            messages = capped.messages
          }
          const context = oaiMessagesToContext(messages, body.tools)
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
            // Emit the terminal usage chunk (stream_options.include_usage). The
            // token counts only exist on the done event; without forwarding them
            // the streaming client counts zero tokens per turn (+0 total=0),
            // which mis-gates compaction and breaks context tracking.
            const u = event.message.usage
            const cacheRead = u.cacheRead ?? 0
            const cacheWrite = u.cacheWrite ?? 0
            const promptTokens = u.input + cacheRead + cacheWrite
            const details =
              cacheRead > 0 || cacheWrite > 0
                ? {
                    prompt_tokens_details: {
                      ...(cacheRead > 0 ? { cached_tokens: cacheRead } : {}),
                      ...(cacheWrite > 0 ? { cache_write_tokens: cacheWrite } : {}),
                    },
                  }
                : {}
            reply.raw.write(
              oaiSseUsageChunk(modelId, {
                prompt_tokens: promptTokens,
                completion_tokens: u.output,
                total_tokens: promptTokens + u.output,
                ...details,
              }),
            )
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
      let usage: {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
        prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
      } = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

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
            const cacheRead = u.cacheRead ?? 0
            const cacheWrite = u.cacheWrite ?? 0
            const promptTokens = u.input + cacheRead + cacheWrite
            usage = {
              prompt_tokens: promptTokens,
              completion_tokens: u.output,
              total_tokens: promptTokens + u.output,
              // Cached-token breakdown (Anthropic prompt caching); 0 for providers without it.
              ...(cacheRead > 0 || cacheWrite > 0
                ? {
                    prompt_tokens_details: {
                      ...(cacheRead > 0 ? { cached_tokens: cacheRead } : {}),
                      ...(cacheWrite > 0 ? { cache_write_tokens: cacheWrite } : {}),
                    },
                  }
                : {}),
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
