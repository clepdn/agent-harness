import path from "node:path"
import { defineService, type CordisContext, type Plugin } from "@nano/plugins"
import {
  NodeToolHost,
  ToolClientHttpServer,
  parseToolCapabilities,
  type ToolClientHttpServerAddress,
} from "@nano/harness-client-node"

export type ToolClientExecutorOptions = {
  workspaceRoot: string
  capabilities?: string
  listenHost?: string
  port?: number
  hashline?: boolean
  authToken?: string
}

export const hostResource = defineService<NodeToolHost>("nano.tool-client.host")
export const serverResource = defineService<ToolClientHttpServer>("nano.tool-client.server")
export const addressResource = defineService<ToolClientHttpServerAddress>("nano.tool-client.address")

export function createToolClientExecutorPlugin(options: ToolClientExecutorOptions): Plugin {
  return {
    name: "nano.tool-client.executor",
    provide: [hostResource.name, serverResource.name, addressResource.name],
    async apply(ctx: CordisContext) {
      const host = new NodeToolHost({
        capabilities: parseToolCapabilities(options.capabilities),
        workspace: { id: path.basename(options.workspaceRoot) || "workspace", root: options.workspaceRoot },
        ...(options.hashline ? { hashline: true } : {}),
      })
      const server = new ToolClientHttpServer({
        host,
        listenHost: options.listenHost ?? "0.0.0.0",
        port: options.port ?? 3002,
        ...(options.authToken ? { authToken: options.authToken } : {}),
      })
      ctx.provide(hostResource.name, host)
      ctx.provide(serverResource.name, server)
      ctx.effect(() => () => server.stop())
      ctx.provide(addressResource.name, await server.start())
    },
  }
}
