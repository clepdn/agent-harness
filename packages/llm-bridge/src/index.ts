/**
 * LLM Bridge — unified inference proxy.
 *
 * All AI requests from the harness go through this bridge. It routes to
 * the appropriate backend based on model name:
 *
 *   - pi-ai models (umans-*, glm-*, etc.) → pi-ai stream()
 *   - gemini-* / antigravity models     → Antigravity bridge (Fastify)
 *   - gpt-* / o3-* / codex models       → Codex bridge (Fastify)
 *
 * The bridge listens on a single port (default 4040) and exposes
 * OpenAI-compatible endpoints. The harness points model.base_url here.
 */

import { loadConfig } from "./config"
import { createServer } from "./server"
import { loadApiKeys } from "./auth"
import { startAntigravityBridge, stopAntigravityBridge } from "./antigravity"
import { startCodexBridge, stopCodexBridge } from "./codex"

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

// Start sub-brides (antigravity, codex) — they run on their own ports
// and the main server proxies to them based on model name
async function startSubBridges() {
  try {
    await startAntigravityBridge()
  } catch (err) {
    console.error("[bridge] antigravity backend failed to start:", err)
  }
  try {
    await startCodexBridge()
  } catch (err) {
    console.error("[bridge] codex backend failed to start:", err)
  }
}

async function main() {
  await startSubBridges()

  const server = createServer(config, apiKeys)

  server.listen(config.port, config.host, () => {
    console.log(`[bridge] listening on http://${config.host}:${config.port}`)
    console.log(`[bridge] models: ${Object.keys(config.models).join(", ")}`)
    console.log(`[bridge] default: ${config.defaultModel}`)
  })
}

main().catch((err) => {
  console.error("[bridge] fatal:", err)
  process.exit(1)
})

// Graceful shutdown
async function shutdown() {
  console.log("[bridge] shutting down...")
  await stopAntigravityBridge()
  await stopCodexBridge()
  process.exit(0)
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
