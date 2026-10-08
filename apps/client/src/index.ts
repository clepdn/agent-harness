import path from "node:path"
import os from "node:os"
import fs from "node:fs"
import { defineService, PluginBus, type PluginScope } from "@nano/plugins"
import { NodeToolHost, ToolClientHttpServer, parseToolCapabilities, type ToolClientHttpServerAddress } from "@nano/harness-client-node"

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const hostResource = defineService<NodeToolHost>("nano.tool-client.host")
const serverResource = defineService<ToolClientHttpServer>("nano.tool-client.server")
const addressResource = defineService<ToolClientHttpServerAddress>("nano.tool-client.address")

async function main(): Promise<void> {
  const workspaceRoot = path.resolve(argument("--workspace") ?? os.homedir())
  const tokenFile = argument("--token-file")
  const authToken = tokenFile ? fs.readFileSync(tokenFile, "utf8").trim() : process.env.NANO_EXECUTOR_TOKEN?.trim()
  if (!authToken) console.warn("[tool-client] WARNING: no auth token set — server is open. Set --token-file or NANO_EXECUTOR_TOKEN for cross-machine use.")
  const config = {
    workspaceRoot,
    capabilities: parseToolCapabilities(argument("--capabilities")),
    listenHost: argument("--host") ?? "0.0.0.0",
    port: Number.parseInt(argument("--port") ?? "3002", 10),
    hashline: process.argv.includes("--hashline"),
    authToken,
  }
  const executorPlugin = {
    id: "nano.tool-client.executor",
    provides: [hostResource, serverResource, addressResource],
    async apply(scope: PluginScope) {
      const host = new NodeToolHost({
        capabilities: config.capabilities,
        workspace: { id: path.basename(config.workspaceRoot) || "workspace", root: config.workspaceRoot },
        ...(config.hashline ? { hashline: true } : {}),
      })
      const server = new ToolClientHttpServer({
        host,
        listenHost: config.listenHost,
        port: config.port,
        ...(config.authToken ? { authToken: config.authToken } : {}),
      })
      scope.provide(hostResource, host)
      scope.provide(serverResource, server)
      scope.own(() => server.stop())
      scope.provide(addressResource, await server.start())
    },
  }
  const bus = new PluginBus()
  await bus.install(executorPlugin)
  const address = bus.get(addressResource)
  const activeWorkspace = bus.get(hostResource).getWorkspace().root
  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    console.log(`[tool-client] ${signal} received, stopping`)
    await bus.close()
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
