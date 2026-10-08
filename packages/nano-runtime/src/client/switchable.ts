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
  private pending: AbortController | null = null
  private operation = 0

  constructor(agentId: string, fallback: ConfiguredToolClient) {
    this.agentId = agentId
    this.fallback = fallback
    this.active = fallback
  }

  async start(signal?: AbortSignal): Promise<void> {
    await this.fallback.start(signal)
  }

  async stop(): Promise<void> {
    this.operation++
    this.pending?.abort(new Error("client stopped"))
    this.pending = null
    const remote = this.remote
    this.remote = null
    this.active = this.fallback
    this.connectedAt = undefined
    if (remote) {
      try { await remote.stop() } catch {}
    }
    await this.fallback.stop()
  }
  async connect(connection: RemoteClientConnection, signal?: AbortSignal): Promise<ActiveClientInfo> {
    signal?.throwIfAborted()
    this.pending?.abort(new Error("client connection superseded"))
    const operation = ++this.operation
    const staging = new AbortController()
    this.pending = staging
    const requestSignal = signal ? AbortSignal.any([staging.signal, signal]) : staging.signal
    const remote = new HttpToolClient({
      agentId: this.agentId,
      endpoint: connection.endpoint,
      ...(connection.capabilities ? { capabilities: connection.capabilities } : {}),
      ...(connection.workspace ? { workspace: connection.workspace } : {}),
    })
    try {
      await remote.start(requestSignal)
      requestSignal.throwIfAborted()
      if (operation !== this.operation) throw new Error("client connection was superseded")
      if (!remote.status().connected) throw new Error(`client executor at ${connection.endpoint} is unreachable`)
      const previousRemote = this.remote
      this.remote = remote
      this.active = remote
      this.connectedAt = new Date().toISOString()
      const info = this.info()
      if (this.pending === staging) this.pending = null
      if (previousRemote) void previousRemote.stop().catch(() => {})
      return info
    } catch (error) {
      await remote.stop()
      throw error
    } finally {
      if (this.pending === staging) this.pending = null
    }
  }

  /** Revert to the default (local) tool client. */
  async disconnect(): Promise<ActiveClientInfo> {
    this.operation++
    this.pending?.abort(new Error("client disconnected"))
    this.pending = null
    const remote = this.remote
    this.remote = null
    this.active = this.fallback
    this.connectedAt = undefined
    if (remote) {
      try { await remote.stop() } catch {}
    }
    return this.info()
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
