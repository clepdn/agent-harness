import type { TextContent, ToolCall, ToolResultMessage } from "../llm"
import type { Message } from "../types"
import { messageStringContent } from "./messages"

const MAX_TOOL_RESULT_SIGNATURE_CHARS = 600

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`

  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort((a, b) => a.localeCompare(b))
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
  return `{${entries.join(",")}}`
}

function truncateForSignature(text: string, maxChars = MAX_TOOL_RESULT_SIGNATURE_CHARS): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}

function collectToolCallSignature(message: Message): string | null {
  if (message.role !== "assistant") return null

  const toolCalls = message.content.filter((c): c is ToolCall => c.type === "toolCall")
  if (toolCalls.length === 0) {
    const text = message.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("")
    return stableSerialize({ no_tools: text || "(empty)" })
  }

  const calls = toolCalls.map((tc) => ({ name: tc.name, args: tc.arguments }))
  return stableSerialize(calls)
}

function collectToolResultSignature(messages: Message[]): string[] {
  return messages
    .filter((m): m is ToolResultMessage => m.role === "toolResult")
    .map((m) => {
      const content = messageStringContent(m)
      return stableSerialize({
        tool_call_id: m.toolCallId,
        content: truncateForSignature(content),
      })
    })
}

/**
 * Checks whether a turn slice contains an injected incoming user event.
 */
export function hasIncomingUserMessage(messages: Message[]): boolean {
  return messages.some((message) => message.role === "user")
}

/**
 * Builds a stable signature for one assistant turn (calls + tool results).
 */
export function buildTurnSignature(turnMessages: Message[]): string | null {
  const assistantMessage = turnMessages.find((message) => message.role === "assistant")
  if (!assistantMessage) return null

  const callSignature = collectToolCallSignature(assistantMessage)
  if (!callSignature) return null

  return stableSerialize({
    calls: callSignature,
    results: collectToolResultSignature(turnMessages),
  })
}
