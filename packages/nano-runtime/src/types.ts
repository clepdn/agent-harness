import type { Message as PiMessage } from "./llm"

/**
 * Pi-ai's canonical conversation message type.
 * UserMessage | AssistantMessage | ToolResultMessage
 */
export type Message = PiMessage

export type TriggerSource = "discord" | "voice" | "bsky" | "webhook" | "cron" | "chat" | "job" | "boredom" | "client"

/**
 * Trigger event from an external source (Discord, cron, etc.).
 * Distinct from pi's conversation UserMessage.
 */
export interface UserMessage {
  source: TriggerSource
  triggeredAt: string
  content: string
  clientId?: string
  raw: unknown
}

export interface RunnerState {
  running: boolean
  systemPrompt: string
  conversation: Message[]
  pendingInputs: UserMessage[]
  tokenCount: number
  contextSize: number
  memoryRecallCooldowns: Record<number, number>
  memoryRecallTurn: number
  memoryRecallPending: boolean
}
