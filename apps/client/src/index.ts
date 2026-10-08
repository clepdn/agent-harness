import path from "node:path"
import os from "node:os"
import fs from "node:fs"
import { CordisContext, getService } from "@nano/plugins"
import { addressResource, createToolClientExecutorPlugin, hostResource } from "@nano/plugin-tool-client-executor"

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}


async function main(): Promise<void> {
  const workspaceRoot = path.resolve(argument("--workspace") ?? os.homedir())
  const tokenFile = argument("--token-file")
  const authToken = tokenFile ? fs.readFileSync(tokenFile, "utf8").trim() : process.env.NANO_EXECUTOR_TOKEN?.trim()
  if (!authToken) console.warn("[tool-client] WARNING: no auth token set — server is open. Set --token-file or NANO_EXECUTOR_TOKEN for cross-machine use.")
  const config = {
    workspaceRoot,
    capabilities: argument("--capabilities"),
    listenHost: argument("--host") ?? "0.0.0.0",
    port: Number.parseInt(argument("--port") ?? "3002", 10),
    hashline: process.argv.includes("--hashline"),
    ...(authToken ? { authToken } : {}),
  }
  const executorPlugin = createToolClientExecutorPlugin(config)
  const ctx = new CordisContext()
  const executorFiber = ctx.plugin(executorPlugin)
  await executorFiber
  const address = getService(ctx, addressResource)
  const activeWorkspace = getService(ctx, hostResource).getWorkspace().root
  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    console.log(`[tool-client] ${signal} received, stopping`)
    await executorFiber.dispose()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  console.log(`[tool-client] listening on ${address.host}:${address.port}; workspace=${activeWorkspace}`)
}

main().catch((error) => {
  console.error("[tool-client] fatal:", error)
  process.exit(1)
})
