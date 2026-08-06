import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { NodeToolHost } from "@nano/harness-client-node"
import type { ClientToolExecutor } from "@nano/harness-core"
import { HttpToolClient, type HttpToolClientStatus } from "@nano/harness-server"
import type { ClientToolName, ClientToolResult, ToolCapability, ToolInvocation, WorkspaceDescriptor } from "@nano/harness-protocol"
import { AGENT_ID, REPO_ROOT } from "../agent-config"
import { config } from "../config"
import { SwitchableToolClient } from "./switchable"

export type ConfiguredToolClient = ClientToolExecutor & {
  start(): Promise<void>
  stop(): Promise<void>
  status(): HttpToolClientStatus
}

class LocalToolClient implements ConfiguredToolClient {
  private readonly agentId: string
  private readonly host: NodeToolHost
  private connected = false

  constructor(agentId: string) {
    this.agentId = agentId
    this.host = new NodeToolHost({
      workspace: {
        id: `${agentId}-server`,
        root: process.env.NANO_CLIENT_WORKSPACE?.trim() || REPO_ROOT,
      },
      hashline: config.tools.hashline,
    })
  }

  async start(): Promise<void> {
    await this.host.start()
    this.connected = true
  }

  async stop(): Promise<void> {
    this.connected = false
    await this.host.stop()
  }

  getCapabilities(): ToolCapability[] {
    return this.host.getCapabilities()
  }

  getWorkspace(): WorkspaceDescriptor {
    return this.host.getWorkspace()
  }

  status(): HttpToolClientStatus {
    return {
      connected: this.connected,
      agentId: this.agentId,
      clientId: "local",
      capabilities: this.getCapabilities(),
      workspace: this.getWorkspace(),
      pendingInvocations: 0,
    }
  }

  execute(input: {
    agentId: string
    tool: ClientToolName
    args: Record<string, unknown>
    timeoutMs?: number
  }): Promise<ClientToolResult> {
    const now = Date.now()
    const invocation: ToolInvocation = {
      type: "tool.call",
      invocationId: randomUUID(),
      agentId: input.agentId,
      tool: input.tool,
      args: input.args,
      issuedAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + (input.timeoutMs ?? 30_000)).toISOString(),
    }
    return this.host.execute(invocation)
  }
}

const client = process.env.NANO_CLIENT?.trim() || "local"

// Shared bearer token for the remote executor. Prefer a file path (agenix
// secret) via NANO_EXECUTOR_TOKEN_FILE, fall back to the raw NANO_EXECUTOR_TOKEN.
function resolveExecutorToken(): string | undefined {
  const file = process.env.NANO_EXECUTOR_TOKEN_FILE?.trim()
  if (file) {
    try {
      return readFileSync(file, "utf8").trim() || undefined
    } catch (error) {
      console.error(`[client] failed to read NANO_EXECUTOR_TOKEN_FILE (${file}):`, error)
      return undefined
    }
  }
  return process.env.NANO_EXECUTOR_TOKEN?.trim() || undefined
}

const executorToken = resolveExecutorToken()
const baseClient: ConfiguredToolClient = client === "local"
  ? new LocalToolClient(AGENT_ID)
  : new HttpToolClient({ agentId: AGENT_ID, endpoint: client, ...(executorToken ? { authToken: executorToken } : {}) })

// The exported client is switchable: it serves `baseClient` by default but a
// client running from the operator's own `pwd` can mount its executor at
// runtime via the /client/connect handshake (see server.ts). This is the
// direct-connection / pwd-mount feature.
export const clientTools: SwitchableToolClient = new SwitchableToolClient(AGENT_ID, baseClient)
