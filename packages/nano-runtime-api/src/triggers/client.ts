import type { ToolCapability, WorkspaceDescriptor } from "@nano/harness-protocol"
import type { UserMessage } from "../types"

export type ClientLifecycleAction = "connected" | "disconnected"

export function fromClientLifecycle(
  action: ClientLifecycleAction,
  workspace: WorkspaceDescriptor | null,
  capabilities: Iterable<ToolCapability>,
  clientId?: string,
): UserMessage {
  const workspaceId = workspace?.id?.trim() || "workspace"
  const workspaceRoot = workspace?.root?.trim() || "(unknown)"
  const toolNames = [...capabilities]
  return {
    source: "client",
    triggeredAt: new Date().toISOString(),
    content: [
      `[client/workspace ${action}]`,
      `A client workspace ${action}.`,
      `workspace_id: ${workspaceId}`,
      `workspace_root: ${workspaceRoot}`,
      `capabilities: ${toolNames.join(", ") || "(none)"}`,
    ].join("\n"),
    ...(clientId ? { clientId } : {}),
    raw: {
      type: `client.workspace.${action}`,
      workspace,
      capabilities: toolNames,
      clientId,
    },
  }
}

