import { loadConfig } from "./config"
import { createServer } from "./server"

const config = loadConfig()

const server = createServer(config)

server.listen(config.port, config.host, () => {
  console.log(`[bridge] listening on http://${config.host}:${config.port}`)
  console.log(`[bridge] models: ${Object.keys(config.models).join(", ")}`)
  console.log(`[bridge] default: ${config.defaultModel}`)
  if (config.authToken) {
    console.log("[bridge] auth: enabled")
  } else {
    console.log("[bridge] auth: disabled")
  }
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
