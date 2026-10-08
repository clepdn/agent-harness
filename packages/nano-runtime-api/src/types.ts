import type { Context, Message as PiMessage } from "./llm"

/**
 * Pi-ai's canonical conversation message type.
 * UserMessage | AssistantMessage | ToolResultMessage
 */
export type Message = PiMessage

export type TriggerSource = "discord" | "voice" | "bsky" | "webhook" | "cron" | "chat" | "job" | "boredom" | "client" | "agent" | "system"

/** Exact Discord routing metadata kept outside model-visible message text. */
export interface DiscordMessageTarget {
  position: number
  friendlyId?: string
  channelId: string
  messageId: string
  itemId?: string
  content: string
  createdAt?: string
}

/**
 * Trigger event from an external source (Discord, cron, etc.).
 * Distinct from pi's conversation UserMessage.
 */
export interface UserMessage {
  source: TriggerSource
  triggeredAt: string
  content: string
  clientId?: string
  discordTargets?: DiscordMessageTarget[]
  raw: unknown
}

export interface RunnerState {
  running: boolean
  context: Context
  pendingInputs: UserMessage[]
  tokenCount: number
  contextSize: number
  memoryRecallCooldowns: Record<number, number>
  memoryRecallTurn: number
  memoryRecallPending: boolean
}
