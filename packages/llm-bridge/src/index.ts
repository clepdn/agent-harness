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

server.listen(config.port, config.host, () => {
  console.log(`[bridge] listening on http://${config.host}:${config.port}`)
  console.log(`[bridge] models: ${Object.keys(config.models).join(", ")}`)
  console.log(`[bridge] default: ${config.defaultModel}`)
})

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[bridge] shutting down...")
  server.close(() => process.exit(0))
})
process.on("SIGINT", () => {
  console.log("[bridge] shutting down...")
  server.close(() => process.exit(0))
})
