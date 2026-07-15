/**
 * LLM Bridge — unified inference proxy.
 *
 * All AI requests from the harness go through this bridge. It routes to
 * the appropriate backend based on model name:
 *
 *   - pi-ai models (umans-*, glm-*, etc.) → pi-ai stream()
 *   - gemini-* / antigravity models     → Antigravity backend
 *   - gpt-* / o3-* / codex models       → Codex backend
 *   - claude-* with OAuth               → Direct Anthropic SDK
 *
 * The bridge listens on a single port (default 4040) and exposes
 * OpenAI-compatible endpoints. The harness points model.base_url here.
 */

import { loadConfig } from "./config"
import { createServer } from "./server"
import { loadApiKeys } from "./auth"

// Parse --keys <path> from argv for the API keys file
const keysArgIdx = process.argv.indexOf("--keys")
const keysPath = keysArgIdx >= 0 ? process.argv[keysArgIdx + 1] : undefined

const apiKeys = loadApiKeys(keysPath)
if (apiKeys.size > 0) {
  console.log(`[bridge] loaded ${apiKeys.size} API key(s) from ${keysPath}`)
  for (const [, entry] of apiKeys) {
    console.log(`[bridge]   key: ${entry.name ?? "(unnamed)"} — models: ${entry.allowedModels.join(", ")}`)
  }
} else {
  console.log("[bridge] no API keys configured — running open (no auth)")
}

const config = loadConfig()

const server = createServer(config, apiKeys)

server.listen({ port: config.port, host: config.host }, () => {
  console.log(`[bridge] listening on http://${config.host}:${config.port}`)
  console.log(`[bridge] models: ${Object.keys(config.models).join(", ")}`)
  console.log(`[bridge] default: ${config.defaultModel}`)
})

// Graceful shutdown
async function shutdown() {
  console.log("[bridge] shutting down...")
  await server.close()
  process.exit(0)
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
