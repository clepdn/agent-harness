import { HttpToolClient, type HttpToolClientStatus } from "@nano/harness-server"
import type {
  ClientToolName,
  ClientToolResult,
  ToolCapability,
  WorkspaceDescriptor,
} from "@nano/harness-protocol"
import type { ConfiguredToolClient } from "./index"

/**
 * A tool client that delegates to a default (usually the in-process local
 * client) but can be dynamically re-pointed at a remote client that connects
 * at runtime via the /client/connect handshake.
 *
 * This is what lets callie run a client from her own `pwd`: the client
 * connects out to the control plane, the control plane switches tool routing
 * to that client's executor for the duration of the session, and reverts to
 * the default when she disconnects.
 */
export type RemoteClientConnection = {
  /** HTTP endpoint of the connecting client's tool executor. */
  endpoint: string
  /** Optional advertised workspace (control plane will re-confirm via /health). */
  workspace?: WorkspaceDescriptor | null
  /** Optional advertised capabilities. */
  capabilities?: ToolCapability[]
}

export type ActiveClientInfo = {
  /** "local" when serving the default, otherwise the remote endpoint. */
  clientId: string
  /** True when a remote client is currently mounted. */
  remote: boolean
  connectedAt?: string
}

export class SwitchableToolClient implements ConfiguredToolClient {
  private readonly agentId: string
  private readonly fallback: ConfiguredToolClient
  private active: ConfiguredToolClient
  private remote: HttpToolClient | null = null
  private connectedAt: string | undefined

  constructor(agentId: string, fallback: ConfiguredToolClient) {
    this.agentId = agentId
    this.fallback = fallback
    this.active = fallback
  }

  async start(): Promise<void> {
    await this.fallback.start()
  }

  async stop(): Promise<void> {
    await this.disconnect()
    await this.fallback.stop()
  }

  /**
   * Mount a remote client's executor as the active tool target. Performs the
   * executor-side health handshake (HttpToolClient.start) so we pick up the
   * real capabilities + workspace the client is exposing. If the executor is
   * unreachable, the previous target is left untouched and an error is thrown.
   */
  async connect(connection: RemoteClientConnection): Promise<ActiveClientInfo> {
    const remote = new HttpToolClient({
      agentId: this.agentId,
      endpoint: connection.endpoint,
      ...(connection.capabilities ? { capabilities: connection.capabilities } : {}),
      ...(connection.workspace ? { workspace: connection.workspace } : {}),
    })
    await remote.start()
    const status = remote.status()
    if (!status.connected) {
      throw new Error(`client executor at ${connection.endpoint} is unreachable`)
    }
    // Drop any prior remote before swapping in the new one.
    await this.disconnectRemoteOnly()
    this.remote = remote
    this.active = remote
    this.connectedAt = new Date().toISOString()
    return this.info()
  }

  /** Revert to the default (local) tool client. */
  async disconnect(): Promise<ActiveClientInfo> {
    await this.disconnectRemoteOnly()
    this.active = this.fallback
    this.connectedAt = undefined
    return this.info()
  }

  private async disconnectRemoteOnly(): Promise<void> {
    if (this.remote) {
      try {
        await this.remote.stop()
      } catch {}
      this.remote = null
    }
  }

  info(): ActiveClientInfo {
    const remote = this.active === this.remote && this.remote !== null
    return {
      clientId: remote && this.remote ? this.remote.status().clientId : "local",
      remote,
      ...(this.connectedAt ? { connectedAt: this.connectedAt } : {}),
    }
  }

  getCapabilities(): ToolCapability[] {
    return this.active.getCapabilities()
  }

  getWorkspace(): WorkspaceDescriptor | null {
    return this.active.getWorkspace()
  }

  status(): HttpToolClientStatus {
    return this.active.status()
  }

  execute(input: {
    agentId: string
    tool: ClientToolName
    args: Record<string, unknown>
    timeoutMs?: number
    signal?: AbortSignal
    onOutput?: (chunk: string) => void
  }): Promise<ClientToolResult> {
    return this.active.execute(input)
  }
}
