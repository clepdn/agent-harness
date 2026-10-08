import type { TextContent, ToolResultMessage, UserMessage, AssistantMessage } from "@nano/runtime-api/llm"
import type { Message } from "@nano/runtime-api/types"
import type { ToolDefinition } from "@nano/harness-core"
import { enabledContextImages } from "@nano/plugin-images/context-images"

export const CONTEXT_SUMMARY_HEADER = "[context summary v1]"

export function messageRole(message: Message): string {
  return message.role
}

export function messageStringContent(message: Message): string {
  if (message.role === "user") {
    if (typeof message.content === "string") return message.content
    return message.content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join(" ").trim()
  }
  if (message.role === "assistant") return message.content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("").trim()
  if (message.role === "toolResult") return message.content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join(" ").trim()
  return ""
}

export function findSummaryMessageIndex(messages: readonly Message[]): number {
  return messages.findIndex((message) => messageStringContent(message).startsWith(CONTEXT_SUMMARY_HEADER))
}

export function estimatePromptTokens(messages: readonly Message[], toolDefinitions: readonly ToolDefinition[] = []): number {
  let imageCount = 0
  const estimatedMessages = messages.map((message) => {
    if (message.role === "assistant") return message
    const { imageReferences, imageAttachments, imageNotes, imagesSuppressed, ...textMessage } = message
    return { ...textMessage, imageAttachments: enabledContextImages(message), imageNotes }
  })
  const jsonChars = JSON.stringify({ messages: estimatedMessages, tools: toolDefinitions }, (_key, value) => {
    if (value?.type === "image" && typeof value.data === "string") {
      imageCount++
      return { ...value, data: "" }
    }
    return value
  }).length
  return Math.ceil(jsonChars / 4) + imageCount * 1024
}

export function errorSummary(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

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
  return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: content }], isError, timestamp: Date.now() }
}
