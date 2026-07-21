/**
 * LLM Bridge — unified inference proxy.
 *
 * Acts as our own OpenRouter. Accepts standard OpenAI format requests,
 * routes to the best available provider, and returns standard OpenAI
 * format responses.
 *
 * Provider routing:
 *   - gemini-* / agy-*     → Antigravity backend (custom)
 *   - gpt-* / o3-* / codex → Codex backend (custom)
 *   - claude-* with OAuth  → Direct Anthropic SDK (custom)
 *   - everything else      → pi-ai registry (openrouter, openai, deepseek, etc.)
 *
 * Custom providers are overlaid on top of pi-ai's built-in model registry.
 */

import { loadConfig } from "./config"
import { createServer, discoverModels } from "./server"
import { loadApiKeys } from "./auth"

/** True only for hosts that stay on the local machine. */
function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === "localhost" || h === "::1" || h === "[::1]" || h.startsWith("127.")
}

const keysArgIdx = process.argv.indexOf("--keys")
const keysPath = keysArgIdx >= 0 ? process.argv[keysArgIdx + 1] : undefined

const config = loadConfig()

const apiKeys = loadApiKeys(keysPath)
if (apiKeys.size > 0) {
  console.log(`[bridge] loaded ${apiKeys.size} API key(s)`)
} else if (isLoopbackHost(config.host)) {
  console.log("[bridge] no API keys configured — running open (no auth) on loopback only")
} else {
  // Fail closed: an unauthenticated bind on a non-loopback interface would expose
  // an open proxy to our provider accounts. Refuse to start.
  console.error(
    `[bridge] refusing to start: no API keys configured, but host is "${config.host}" ` +
      "(not loopback). Provide a --keys file, or bind host to 127.0.0.1.",
  )
  process.exit(1)
}

async function main() {
  // Discover models from custom providers + pi-ai registry
  await discoverModels(config)

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
