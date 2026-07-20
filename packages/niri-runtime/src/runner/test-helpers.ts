import type { UserMessage, AssistantMessage, ToolResultMessage } from "../llm"
import type { Message } from "../types"

export function makeUserMessage(content: string): UserMessage {
  return { role: "user", content, timestamp: Date.now() }
}

export function makeAssistantMessage(text: string, extra?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
    ...extra,
  }
}

export function makeToolResultMessage(toolCallId: string, toolName: string, content: string, isError = false): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: content }],
    isError,
    timestamp: Date.now(),
  }
}

export function msg(content: string): Message {
  return makeUserMessage(content)
}
