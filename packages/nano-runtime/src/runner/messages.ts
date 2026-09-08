import type { ImageContent, TextContent, ToolCall, ToolResultMessage } from "../llm"
import type { Message } from "../types"
import { TOOLS, isToolEnabled } from "./tools"
import { enabledContextImages } from "../context-images"

// ── Shared constants ──────────────────────────────────────────────────────────

export const CONTEXT_SUMMARY_HEADER = "[context summary v1]"

// ── Low-level message helpers ─────────────────────────────────────────────────

export function messageRole(message: Message): string {
  return message.role
}

export function messageStringContent(message: Message): string {
  if (message.role === "user") {
    if (typeof message.content === "string") return message.content
    return message.content
      .filter((p): p is TextContent => p.type === "text")
      .map((p) => p.text)
      .join(" ")
      .trim()
  }
  if (message.role === "assistant") {
    return message.content
      .filter((p): p is TextContent => p.type === "text")
      .map((p) => p.text)
      .join("")
      .trim()
  }
  if (message.role === "toolResult") {
    return message.content
      .filter((p): p is TextContent => p.type === "text")
      .map((p) => p.text)
      .join(" ")
      .trim()
  }
  return ""
}

// ── Structural message utilities ──────────────────────────────────────────────

export function findSummaryMessageIndex(messages: Message[]): number {
  return messages.findIndex((message) => {
    const content = messageStringContent(message)
    return content.startsWith(CONTEXT_SUMMARY_HEADER)
  })
}

/**
 * Very rough tokenizer-agnostic estimate for prompt size guardrails.
 * Includes both messages and tool schema to mirror the actual completion payload.
 */
export function estimatePromptTokens(messages: Message[]): number {
  let imageCount = 0
  const estimatedMessages = messages.map((message) => {
    if (message.role === "assistant") return message
    const { imageReferences, imageAttachments, imageNotes, imagesSuppressed, ...textMessage } = message
    return { ...textMessage, imageAttachments: enabledContextImages(message), imageNotes }
  })
  const jsonChars = JSON.stringify({ messages: estimatedMessages, tools: TOOLS.filter((t) => isToolEnabled(t.name)) }, (_key, value) => {
    if (value?.type === "image" && typeof value.data === "string") {
      imageCount++
      return { ...value, data: "" }
    }
    return value
  }).length
  // Image token costs depend on the model and dimensions, not encoded file size.
  return Math.ceil(jsonChars / 4) + imageCount * 1024
}

// ── sanitizeMessages ──────────────────────────────────────────────────────────

/** Move mis-ordered tool results back into place and synthesize missing ones. */
export function sanitizeMessages(msgs: Message[]): Message[] {
  let i = 0
  while (i < msgs.length) {
    const msg = msgs[i]!
    if (msg.role === "assistant") {
      const toolCalls = msg.content.filter((c): c is ToolCall => c.type === "toolCall")
      if (toolCalls.length > 0) {
        const expectedIds = toolCalls.map((tc) => tc.id)
        const needed = new Set(expectedIds)
        let j = i + 1
        while (j < msgs.length && msgs[j]!.role === "toolResult" && needed.has((msgs[j] as ToolResultMessage).toolCallId)) {
          needed.delete((msgs[j] as ToolResultMessage).toolCallId)
          j++
        }
        if (needed.size > 0) {
          const toolResponses = new Map<string, Message>()
          const others: Message[] = []
          for (let k = j; k < msgs.length; k++) {
            const m = msgs[k]!
            if (m.role === "toolResult" && needed.has(m.toolCallId)) {
              toolResponses.set(m.toolCallId, m)
              needed.delete(m.toolCallId)
            } else {
              others.push(m)
            }
          }

          const inserted: Message[] = []
          let synthesized = 0
          for (const tc of toolCalls) {
            if (toolResponses.has(tc.id)) {
              inserted.push(toolResponses.get(tc.id)!)
              continue
            }
            // already present in the contiguous block?
            if (msgs.slice(i + 1, j).some((m) => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === tc.id)) {
              continue
            }
            inserted.push({
              role: "toolResult",
              toolCallId: tc.id,
              toolName: tc.name,
              content: [{ type: "text", text: "error: missing tool response recovered by runner before API request." }],
              isError: true,
              timestamp: Date.now(),
            })
            synthesized++
          }

          if (inserted.length > 0) {
            msgs = [...msgs.slice(0, j), ...inserted, ...others]
            console.log(
              synthesized > 0
                ? `[runner] repaired tool_calls at message ${i}; synthesized ${synthesized} missing tool response(s)`
                : `[runner] repaired orphaned tool_calls at message ${i}`,
            )
          }
        }
      }
    }
    i++
  }
  return msgs
}

// ── Error detection ───────────────────────────────────────────────────────────

const PROMPT_TOO_LARGE_PHRASES = [
  "prompt exceeds max length", "prompt is too long", "context length", "maximum context",
  "context_length_exceeded", "too many tokens", "reduce the length", "prompt length",
  "input length", "too long for", "request too large",
]

const CONTENT_FILTER_PHRASES = [
  "potentially unsafe or sensitive content", "sensitive content in input or generation",
  "content filter", "content_filter", "may generate sensitive content",
]

const IMAGE_PARSE_PHRASES = [
  "图片输入格式", "图片解析", "图片格式",
  "image parse", "image format", "invalid image", "failed to parse image", "decode image", "1210",
]

export function shouldFallback(errorMessage: string): boolean {
  const statusMatch = errorMessage.match(/\b(\d{3})\b/)
  if (statusMatch) {
    const status = parseInt(statusMatch[1]!)
    return !status || status === 429 || status >= 500
  }
  return /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EPIPE|UND_ERR|fetch failed|terminated|socket hang up|other side closed|timed out/i.test(errorMessage)
}

export function isPromptTooLargeError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase()
  return PROMPT_TOO_LARGE_PHRASES.some((phrase) => lower.includes(phrase))
}

export function isContentFilterError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase()
  return CONTENT_FILTER_PHRASES.some((phrase) => lower.includes(phrase))
}

export function isImageParseError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase()
  return IMAGE_PARSE_PHRASES.some((phrase) => lower.includes(phrase.toLowerCase()))
}

// ── Image scrubbing ───────────────────────────────────────────────────────────

const SCRUBBED_IMAGE_PLACEHOLDER = "[the system has rejected this :( its not your fault]"

export function scrubImagesFromConversation(msgs: Message[]): number {
  let scrubbed = 0
  for (const msg of msgs) {
    if (msg.role !== "assistant" && (msg.imageAttachments?.length || msg.imageReferences?.length)) {
      scrubbed += msg.imageAttachments?.length ?? 0
      msg.imageAttachments = []
      msg.imagesSuppressed = true
      msg.imageNotes = [SCRUBBED_IMAGE_PLACEHOLDER]
    }
    if (msg.role === "user") {
      if (typeof msg.content === "string") continue
      const parts = msg.content
      let changed = false
      const next: typeof parts = []
      for (const part of parts) {
        if (part.type === "image") {
          next.push({ type: "text", text: SCRUBBED_IMAGE_PLACEHOLDER })
          scrubbed++
          changed = true
        } else {
          next.push(part)
        }
      }
      if (changed) (msg as { content: unknown }).content = next
    } else if (msg.role === "toolResult") {
      const parts = msg.content
      let changed = false
      const next: (TextContent | ImageContent)[] = []
      for (const part of parts) {
        if (part.type === "image") {
          next.push({ type: "text", text: SCRUBBED_IMAGE_PLACEHOLDER })
          scrubbed++
          changed = true
        } else {
          next.push(part)
        }
      }
      if (changed) (msg as { content: unknown }).content = next
    }
  }
  return scrubbed
}

// ── Misc utilities ────────────────────────────────────────────────────────────

export function errorSummary(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Default retry backoff — 60 s. */
export const retryDelayMs = 60_000

export function parseImageDetail(value: unknown): "auto" | "low" | "high" {
  if (value === "low" || value === "high" || value === "auto") return value
  return "auto"
}
