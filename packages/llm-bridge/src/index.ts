/**
 * LLM Bridge — unified inference proxy.
 *
 * Acts as our own OpenRouter. Routes requests to the appropriate backend:
 *
 *   - gemini-* / agy-*     → Antigravity backend
 *   - gpt-* / o3-* / codex → Codex backend
 *   - everything else      → transparent proxy to upstream API
 *
 * Models are auto-discovered from the upstream /v1/models endpoint on startup.
 * The bridge listens on a single port and exposes OpenAI-compatible endpoints.
 */

import { loadConfig } from "./config"
import { createServer, fetchUpstreamModels } from "./server"
import { loadApiKeys } from "./auth"

const keysArgIdx = process.argv.indexOf("--keys")
const keysPath = keysArgIdx >= 0 ? process.argv[keysArgIdx + 1] : undefined

const apiKeys = loadApiKeys(keysPath)
if (apiKeys.size > 0) {
  console.log(`[bridge] loaded ${apiKeys.size} API key(s)`)
} else {
  console.log("[bridge] no API keys configured — running open (no auth)")
}

const config = loadConfig()

async function main() {
  // Discover models from upstream
  console.log(`[bridge] fetching models from ${config.upstreamBaseUrl}...`)
  config.models = await fetchUpstreamModels(config.upstreamBaseUrl, config.upstreamApiKey)
  console.log(`[bridge] discovered ${config.models.length} models: ${config.models.map((m) => m.id).join(", ")}`)

  const server = createServer(config, apiKeys)

  await server.listen({ port: config.port, host: config.host })
  console.log(`[bridge] listening on http://${config.host}:${config.port}`)
}

main().catch((err) => {
  console.error("[bridge] fatal:", err)
  process.exit(1)
})

async function shutdown() {
  console.log("[bridge] shutting down...")
  process.exit(0)
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
