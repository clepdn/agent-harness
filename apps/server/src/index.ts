import path from "node:path"
import { fileURLToPath } from "node:url"
import { createControlApplication } from "./control/application"
import { controlApplicationOptions } from "./server-options"

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const applicationOptions = controlApplicationOptions(process.argv.slice(2))
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const agentDirectory = path.resolve(argument("--agents") ?? path.join(repoRoot, "agents"))

async function main(): Promise<void> {
  process.umask(0o077)
  const application = await createControlApplication({
    config: applicationOptions.config,
    controlPort: applicationOptions.port,
    agentDirectory,
    repoRoot,
  })

  try {
    await application.server.listen({ port: applicationOptions.port, host: applicationOptions.host })
  } catch (error) {
    await application.close().catch(() => {})
    throw error
  }

  console.log(`[server] control plane listening on ${applicationOptions.host}:${applicationOptions.port}`)

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    console.log(`[server] ${signal} received, stopping control plane`)
    await application.close()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
}

main().catch((error) => {
  console.error("[server] fatal:", error)
  process.exit(1)
})
