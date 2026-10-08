import { readFileSync } from "node:fs"
import { basename } from "node:path"
import { randomUUID } from "node:crypto"
import { NodeToolHost } from "@nano/harness-client-node"
import type { ClientToolExecutor } from "@nano/harness-core"
import { HttpToolClient } from "@nano/harness-server"
import type { HttpToolClientStatus } from "@nano/harness-server"
import type { ClientToolName, ClientToolResult, ToolCapability, ToolInvocation, WorkspaceDescriptor } from "@nano/harness-protocol"
import { AGENT_ID, REPO_ROOT } from "@nano/runtime-api/agent-config"
import { config } from "@nano/runtime-api/config"
import { SwitchableToolClient } from "./switchable"

export type ConfiguredToolClient = ClientToolExecutor & {
  start(signal?: AbortSignal): Promise<void>
  stop(): Promise<void>
  status(): HttpToolClientStatus
}

export interface ConfiguredToolClientOptions {
  readonly agentId?: string
  readonly endpoint?: string
  readonly authToken?: string
  readonly workspaceRoot?: string
  readonly hashline?: boolean
}

class LocalToolClient implements ConfiguredToolClient {
  private readonly agentId: string
  private readonly host: NodeToolHost
  private connected = false

  constructor(agentId: string, workspaceRoot: string, hashline: boolean) {
    this.agentId = agentId
    this.host = new NodeToolHost({
      workspace: {
        id: `${agentId}-server`,
        root: workspaceRoot,
      },
      hashline,
    })
  }

  async start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    await this.host.start()
    if (signal?.aborted) {
      await this.host.stop()
      signal.throwIfAborted()
    }
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
    signal?: AbortSignal
    onOutput?: (chunk: string) => void
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
    return this.host.execute(invocation, input.signal, input.onOutput)
  }
}

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

/** Construct clients only when a runtime generation is applied. */
export function createConfiguredToolClient(options: ConfiguredToolClientOptions = {}): SwitchableToolClient {
  const agentId = options.agentId?.trim() || AGENT_ID
  const endpoint = options.endpoint ?? (process.env.NANO_CLIENT?.trim() || "local")
  const workspaceRoot = options.workspaceRoot ?? (process.env.NANO_CLIENT_WORKSPACE?.trim() || REPO_ROOT)
  const authToken = options.authToken?.trim() || resolveExecutorToken()
  const fallback: ConfiguredToolClient = endpoint === "local"
    ? new LocalToolClient(agentId, workspaceRoot, options.hashline ?? config.tools.hashline)
    : new HttpToolClient({ agentId, endpoint, ...(authToken ? { authToken } : {}) })
  return new SwitchableToolClient(agentId, fallback)
}
/**
 * Pull a file off the attached client as raw bytes. Tool-supplied paths name
 * the client's filesystem, which is a different machine whenever the executor
 * is remote, so anything the control plane has to hold in memory (a Discord
 * upload, say) has to come across the wire.
 */
export async function readClientFile(
  client: ClientToolExecutor,
  filePath: string,
  maxBytes?: number,
  timeoutMs = 120_000,
  agentId = AGENT_ID,
): Promise<{ path: string; name: string; mime: string; data: Buffer }> {
  const result = await client.execute({
    agentId,
    tool: "read_bytes",
    args: { path: filePath, ...(maxBytes === undefined ? {} : { max_bytes: maxBytes }) },
    timeoutMs,
  })
  if (result.status !== "ok" || !result.file) {
    throw new Error(result.output?.replace(/^error:\s*/, "") || "read_bytes returned no file")
  }
  const { file } = result
  return {
    path: file.path,
    name: basename(file.path),
    mime: file.mime,
    data: Buffer.from(file.dataUrl.slice(file.dataUrl.indexOf(",") + 1), "base64"),
  }
}
