import type OpenAI from "openai"
import type { Message } from "../types"
import type { ImageDetail } from "./types"
import type { ToolArgs } from "./loop-shared"
import { TOOLS } from "./tools"

// ── Shared constants ──────────────────────────────────────────────────────────

export const CONTEXT_SUMMARY_HEADER = "[context summary v1]"

// ── Low-level message helpers (also used by summarize.ts) ─────────────────────

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

export function messageRole(message: Message): string {
  const record = asRecord(message)
  return typeof record?.role === "string" ? record.role : ""
}

export function messageStringContent(message: Message): string {
  const record = asRecord(message)
  const content = record?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  const chunks: string[] = []
  for (const part of content) {
    const partRecord = asRecord(part)
    if (!partRecord) continue
    if (partRecord.type === "text" && typeof partRecord.text === "string") {
      chunks.push(partRecord.text)
      continue
    }
    if (partRecord.type === "image_url") chunks.push("[image]")
  }

  return chunks.join(" ")
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
  const jsonChars = JSON.stringify({ messages, tools: TOOLS }).length
  return Math.ceil(jsonChars / 4)
}

// ── sanitizeMessages ──────────────────────────────────────────────────────────

/** Move mis-ordered tool responses back into place and synthesize missing ones. */
export function sanitizeMessages(msgs: Message[]): Message[] {
  let i = 0
  while (i < msgs.length) {
    const msg = msgs[i]
    if (msg.role === "assistant" && Array.isArray((msg as OpenAI.Chat.ChatCompletionMessage).tool_calls)) {
      const toolCalls = (msg as OpenAI.Chat.ChatCompletionMessage).tool_calls!
      const expectedIds = toolCalls.map((tc) => tc.id).filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      const needed = new Set(expectedIds)
      let j = i + 1
      while (j < msgs.length && msgs[j].role === "tool" && needed.has((msgs[j] as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id)) {
        needed.delete((msgs[j] as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id)
        j++
      }
      if (needed.size > 0) {
        const toolResponses = new Map<string, Message>()
        const others: Message[] = []
        for (let k = j; k < msgs.length; k++) {
          const m = msgs[k]
          const id = m.role === "tool" ? (m as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id : undefined
          if (typeof id === "string" && needed.has(id)) {
            toolResponses.set(id, m)
            needed.delete(id)
          } else {
            others.push(m)
          }
        }

        const inserted: Message[] = []
        let synthesized = 0
        for (const id of expectedIds) {
          if (!toolResponses.has(id)) {
            if (msgs.slice(i + 1, j).some((m) => m.role === "tool" && (m as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id === id)) {
              continue
            }
            inserted.push({ role: "tool", tool_call_id: id, content: "error: missing tool response recovered by runner before API request." })
            synthesized++
            continue
          }
          inserted.push(toolResponses.get(id)!)
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
    // Ensure assistant messages always have content or tool_calls (providers reject null+empty)
    if (msg.role === "assistant") {
      const aMsg = msg as OpenAI.Chat.ChatCompletionMessage
      if ((aMsg.content === null || aMsg.content === undefined) && (!aMsg.tool_calls || aMsg.tool_calls.length === 0)) {
        aMsg.content = ""
      }
    }
    i++
  }
  return msgs
}

// ── Error detection (string-based — pi surfaces errors as messages) ───────────

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
    const status = parseInt(statusMatch[1])
    return !status || status === 429 || status >= 500
  }
  return /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EPIPE|UND_ERR|fetch failed|terminated|socket hang up|other side closed/i.test(errorMessage)
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
    const record = asRecord(msg)
    if (!record) continue
    const content = record.content
    if (!Array.isArray(content)) continue
    let changed = false
    const next: unknown[] = []
    for (const part of content) {
      const partRecord = asRecord(part)
      if (partRecord && partRecord.type === "image_url") {
        next.push({ type: "text", text: SCRUBBED_IMAGE_PLACEHOLDER })
        scrubbed++
        changed = true
        continue
      }
      next.push(part)
    }
    if (changed) record.content = next
  }
  return scrubbed
}

// ── Misc utilities ────────────────────────────────────────────────────────────

export function errorSummary(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Default retry backoff — 60 s. Pi surfaces errors as messages so we can't read Retry-After headers. */
export const retryDelayMs = 60_000

export function parseImageDetail(value: unknown): ImageDetail {
  if (value === "low" || value === "high" || value === "auto") return value
  return "auto"
}

// ── parseToolArguments ────────────────────────────────────────────────────────

function extractLeadingJsonObject(raw: string): string | null {
  const start = raw.indexOf("{")
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (escaped) { escaped = false }
      else if (ch === "\\") { escaped = true }
      else if (ch === '"') { inString = false }
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === "{") { depth++; continue }
    if (ch === "}") { depth--; if (depth === 0) return raw.slice(start, i + 1) }
  }
  return null
}

function decodeHtmlEntities(input: string): string {
  if (!input.includes("&")) return input
  return input.replace(/&(gt|lt|amp|quot|#39|#x27|#x2f);/gi, (entity, key: string) => {
    switch (key.toLowerCase()) {
      case "gt": return ">"
      case "lt": return "<"
      case "amp": return "&"
      case "quot": return '"'
      case "#39": case "#x27": return "'"
      case "#x2f": return "/"
      default: return entity
    }
  })
}

function decodeHtmlEntitiesDeep<T>(value: T): T {
  if (typeof value === "string") return decodeHtmlEntities(value) as T
  if (Array.isArray(value)) return value.map((item) => decodeHtmlEntitiesDeep(item)) as T
  if (!value || typeof value !== "object") return value
  const entries = Object.entries(value as Record<string, unknown>).map(([key, v]) => [key, decodeHtmlEntitiesDeep(v)])
  return Object.fromEntries(entries) as T
}

export function parseToolArguments(rawArgs: unknown): { ok: true; args: ToolArgs } | { ok: false; error: string } {
  if (typeof rawArgs !== "string") {
    return { ok: false, error: `arguments must be a JSON string, got ${typeof rawArgs}` }
  }

  const parseObject = (input: string): ToolArgs | null => {
    const parsed = JSON.parse(input)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return decodeHtmlEntitiesDeep(parsed as ToolArgs)
  }

  const inputs = [rawArgs]
  const decodedRawArgs = decodeHtmlEntities(rawArgs)
  if (decodedRawArgs !== rawArgs) inputs.push(decodedRawArgs)

  let lastError: unknown = null
  for (const input of inputs) {
    try {
      const parsed = parseObject(input)
      if (parsed) return { ok: true, args: parsed }
      return { ok: false, error: "arguments must be a JSON object" }
    } catch (err) {
      lastError = err
      const recovered = extractLeadingJsonObject(input)
      if (!recovered) continue
      try {
        const parsed = parseObject(recovered)
        if (parsed) return { ok: true, args: parsed }
      } catch { /* fall through */ }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  const preview = rawArgs.length > 180 ? `${rawArgs.slice(0, 180)}...` : rawArgs
  return { ok: false, error: `${message}; raw=${JSON.stringify(preview)}` }
}
