import type { ClientToolExecutor } from "@nano/harness-core"
import type { HttpToolClientStatus } from "@nano/harness-server"
import type { ClientToolName, ClientToolResult, ToolCapability, WorkspaceDescriptor } from "@nano/harness-protocol"

export type RemoteClientConnection = {
  endpoint: string
  workspace?: WorkspaceDescriptor | null
  capabilities?: ToolCapability[]
}

export type ActiveClientInfo = {
  clientId: string
  remote: boolean
  connectedAt?: string
}

export type ClientConnectionStatus = HttpToolClientStatus

export interface SwitchableToolClient extends ClientToolExecutor {
  start(signal?: AbortSignal): Promise<void>
  stop(): Promise<void>
  connect(connection: RemoteClientConnection, signal?: AbortSignal): Promise<ActiveClientInfo>
  disconnect(): Promise<ActiveClientInfo>
  info(): ActiveClientInfo
  getCapabilities(): ToolCapability[]
  getWorkspace(): WorkspaceDescriptor | null
  status(): ClientConnectionStatus
  execute(input: {
    agentId: string
    tool: ClientToolName
    args: Record<string, unknown>
    timeoutMs?: number
    signal?: AbortSignal
    onOutput?: (chunk: string) => void
  }): Promise<ClientToolResult>
}
