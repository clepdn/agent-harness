import path from "node:path"
import os from "node:os"
import {
  NodeToolHost,
  ToolClientHttpServer,
  parseToolCapabilities,
} from "@nano/harness-client-node"

export type ExecutorOptions = {
  workspaceRoot: string
  capabilities?: string
  listenHost?: string
  port?: number
  hashline?: boolean
}

export type RunningExecutor = {
  url: string
  host: string
  port: number
  workspaceRoot: string
  capabilities: string[]
  stop: () => Promise<void>
}

/**
 * Boot an in-process tool executor bound to the operator's working directory.
 * This is the thing the control plane will call back into to run shell/file
 * tools directly against the operator's pwd once the handshake completes.
 */
export async function startExecutor(options: ExecutorOptions): Promise<RunningExecutor> {
  const workspaceRoot = path.resolve(options.workspaceRoot || os.homedir())
  const host = new NodeToolHost({
    capabilities: parseToolCapabilities(options.capabilities),
    workspace: {
      id: path.basename(workspaceRoot) || "workspace",
      root: workspaceRoot,
    },
    ...(options.hashline ? { hashline: true } : {}),
  })
  const server = new ToolClientHttpServer({
    host,
    listenHost: options.listenHost ?? "127.0.0.1",
    port: options.port ?? 0,
  })
  const address = await server.start()
  return {
    url: `http://${address.host}:${address.port}`,
    host: address.host,
    port: address.port,
    workspaceRoot,
    capabilities: host.getCapabilities(),
    stop: () => server.stop(),
  }
}
