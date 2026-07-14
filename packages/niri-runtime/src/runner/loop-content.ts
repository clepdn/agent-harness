import type { AssistantMessage, TextContent, ToolCall } from "@earendil-works/pi-ai"
import type { LoopState } from "./types"

/**
 * Extracts plain text from an assistant message's content array.
 *
 * @param content - Pi assistant message content array.
 * @returns Trimmed concatenated text.
 */
export function assistantContentText(content: AssistantMessage["content"]): string {
  return content
    .filter((p): p is TextContent => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim()
}

/**
 * Returns the most recent assistant message text from loop state.
 *
 * @param state - Mutable loop state.
 * @returns Latest assistant text, or empty string when none exists.
 */
export function latestAssistantContent(state: LoopState): string {
  for (let i = state.conversation.length - 1; i >= 0; i--) {
    const message = state.conversation[i]
    if (!message || message.role !== "assistant") continue
    return assistantContentText(message.content)
  }
  return ""
}

/**
 * Type guard that confirms a content part is a tool call.
 *
 * @param part - Content part from an assistant message.
 * @returns `true` when the part is a ToolCall.
 */
export function isFunctionToolCall(part: AssistantMessage["content"][number]): part is ToolCall {
  return part.type === "toolCall"
}
