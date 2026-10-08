import type { RuntimeKind } from "./runner"
import type { UserMessage } from "../types"

export interface AgentChannelRow {
  id: string
  sender: RuntimeKind
  recipient: RuntimeKind
  content: string
  created_at: string
  delivered_at: string | null
}

export interface AgentChannelService {
  sendAgentChannelMessage(sender: RuntimeKind, content: unknown): Promise<Record<string, unknown>>
  listAgentChannelMessages(params?: { limit?: unknown; beforeId?: unknown }): Record<string, unknown>
}

export type AgentChannelDelivery = (recipient: RuntimeKind, event: UserMessage) => Promise<boolean> | boolean

export interface AgentMailbox extends AgentChannelService {
  runtimeReady(kind: RuntimeKind): Promise<void>
}
