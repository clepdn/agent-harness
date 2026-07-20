// Direct Anthropic API client for subscription (OAuth) models.
// Handles Claude Code identity headers, billing attribution, and OAuth auth.
// Bypasses pi-ai entirely for Anthropic subscription models.

import Anthropic from "@anthropic-ai/sdk"
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { AssistantMessageEvent } from "@earendil-works/pi-ai"
import { oaiContentToText, type OaiContentPart } from "./translate"

const CLAUDE_CODE_VERSION = "2.1.92"

const OAUTH_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "extended-cache-ttl-2025-04-11",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
]

// ── Prompt caching ──────────────────────────────────────────────────────────
// Anthropic's only cache type is "ephemeral"; the knob is TTL (5m default / 1h).
type CacheControl = { type: "ephemeral"; ttl: "5m" | "1h" }
const CACHE_1H: CacheControl = { type: "ephemeral", ttl: "1h" }

// ── Device ID ─────────────────────────────────────────────────────────────────

function getOrCreateDeviceId(): string {
  const dir = join(homedir(), ".pi")
  const path = join(dir, "device-id")
  try {
    if (existsSync(path)) {
      const id = readFileSync(path, "utf-8").trim()
      if (id.length > 0) return id
    }
  } catch {}
  const id = randomBytes(32).toString("hex")
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, id, { mode: 0o600 })
  } catch {}
  return id
}

// ── Client creation ───────────────────────────────────────────────────────────

export function createAnthropicClient(accessToken: string, baseUrl?: string): Anthropic {
  return new Anthropic({
    apiKey: null,
    authToken: accessToken,
    baseURL: baseUrl ?? "https://api.anthropic.com",
    dangerouslyAllowBrowser: true,
    defaultHeaders: {
      "accept": "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": OAUTH_BETAS.join(","),
      "user-agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
      "x-app": "cli",
    },
  })
}

// ── Message translation ───────────────────────────────────────────────────────

interface OaiMessage {
  role: string
  content?: string | OaiContentPart[] | null
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
}

/** Convert an OpenAI image data/URL string to an Anthropic image block. */
function imageUrlToBlock(url: string): Anthropic.ImageBlockParam | null {
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (dataUrl) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: dataUrl[1] as Anthropic.Base64ImageSource["media_type"],
        data: dataUrl[2]!,
      },
    }
  }
  if (/^https?:\/\//.test(url)) {
    return { type: "image", source: { type: "url", url } }
  }
  return null
}

/**
 * Convert OpenAI user content (a plain string or an array of content parts)
 * into Anthropic content blocks, preserving text and images. Array-form
 * content is what clients like pi send; dropping it yields an empty request.
 */
function oaiContentToBlocks(content: unknown): Anthropic.ContentBlockParam[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: Anthropic.ContentBlockParam[] = []
  for (const part of content as OaiContentPart[]) {
    if (!part || typeof part !== "object") continue
    if (typeof part.text === "string") {
      if (part.text) blocks.push({ type: "text", text: part.text })
    } else if (part.type === "image_url" && part.image_url) {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url.url
      const block = url ? imageUrlToBlock(url) : null
      if (block) blocks.push(block)
    }
  }
  return blocks
}

interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
  cache_control?: CacheControl
}

function oaiToAnthropicMessages(messages: OaiMessage[]): {
  system: Anthropic.TextBlockParam[]
  messages: Anthropic.MessageParam[]
} {
  const systemBlocks: Anthropic.TextBlockParam[] = []
  const anthropicMessages: Anthropic.MessageParam[] = []
  let userBlocks: Anthropic.ContentBlockParam[] = []

  function flushUserBlocks() {
    if (userBlocks.length > 0) {
      anthropicMessages.push({ role: "user", content: userBlocks })
      userBlocks = []
    }
  }

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
      case "developer": {
        const text = oaiContentToText(msg.content)
        if (text) systemBlocks.push({ type: "text", text })
        break
      }
      case "user": {
        userBlocks.push(...oaiContentToBlocks(msg.content))
        break
      }
      case "assistant": {
        flushUserBlocks()
        const blocks: Anthropic.ContentBlockParam[] = []
        const text = oaiContentToText(msg.content)
        if (text) {
          blocks.push({ type: "text", text })
        }
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let input: Record<string, unknown> = {}
            try { input = JSON.parse(tc.function.arguments) } catch {}
            blocks.push({
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input,
            })
          }
        }
        if (blocks.length > 0) {
          anthropicMessages.push({ role: "assistant", content: blocks })
        }
        break
      }
      case "tool": {
        flushUserBlocks()
        anthropicMessages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: msg.tool_call_id ?? "",
            content: oaiContentToText(msg.content) || JSON.stringify(msg.content ?? ""),
          }],
        })
        break
      }
    }
  }
  flushUserBlocks()

  // Prepend billing + Claude Code identity for OAuth
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}; cc_entrypoint=cli; cch=00000;` },
    ...systemBlocks,
  ]

  return { system, messages: anthropicMessages }
}

function oaiToolsToAnthropic(tools?: Array<{ function: { name: string; description: string; parameters: Record<string, unknown> } }>): AnthropicTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }))
}

function markCache(block: unknown, cc: CacheControl): void {
  if (block && typeof block === "object") {
    ;(block as { cache_control?: CacheControl }).cache_control = cc
  }
}

/**
 * Inject Anthropic prompt-cache breakpoints, all at 1h TTL:
 *   - the last tool + the last system block (the stable prefix), and
 *   - the final block of the last two messages (rolling).
 *
 * A breakpoint caches everything before it, so the rolling message breakpoint
 * covers the ENTIRE history — giving a 1h cache for the whole conversation, not
 * just system/tools. At most 4 breakpoints; a uniform TTL trivially satisfies
 * Anthropic's longer-before-shorter ordering rule. Turn N's rolling breakpoint
 * becomes turn N+1's cache read, and reads refresh the TTL — so an active session
 * stays cached and a gap of up to an hour still resumes from cache.
 *
 * These markers live here — NOT in oaiToAnthropicMessages — on purpose, so the
 * translated content prefix stays byte-identical turn-to-turn (the thing prefix
 * caching actually keys on). See translate.test.ts.
 */
function applyCacheBreakpoints(
  system: Anthropic.TextBlockParam[],
  messages: Anthropic.MessageParam[],
  tools?: AnthropicTool[],
): void {
  if (tools && tools.length > 0) markCache(tools[tools.length - 1], CACHE_1H)
  if (system.length > 0) markCache(system[system.length - 1], CACHE_1H)
  for (const msg of messages.slice(-2)) {
    const content = msg.content
    if (Array.isArray(content) && content.length > 0) {
      markCache(content[content.length - 1], CACHE_1H)
    }
  }
}

// ── Streaming ─────────────────────────────────────────────────────────────────

export async function* streamAnthropicDirect(
  client: Anthropic,
  request: {
    model: string
    messages: OaiMessage[]
    tools?: Array<{ function: { name: string; description: string; parameters: Record<string, unknown> } }>
    max_tokens?: number
    temperature?: number
  },
): AsyncIterable<AssistantMessageEvent> {
  const { system, messages } = oaiToAnthropicMessages(request.messages)
  const tools = oaiToolsToAnthropic(request.tools)
  applyCacheBreakpoints(system, messages, tools)
  const deviceId = getOrCreateDeviceId()

  const params = {
    model: request.model,
    max_tokens: request.max_tokens ?? 8192,
    system,
    messages,
    ...(tools ? { tools } : {}),
    stream: true,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  }

  const stream = await client.messages.stream(params as any, {
    headers: {
      "X-Device-Id": deviceId,
    },
  })

  let contentIndex = 0
  let toolUseIndex = -1
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0

  for await (const event of stream) {
    switch (event.type) {
      case "message_start": {
        const u = event.message.usage
        inputTokens = u?.input_tokens ?? 0
        cacheReadTokens = u?.cache_read_input_tokens ?? 0
        cacheWriteTokens = u?.cache_creation_input_tokens ?? 0
        yield { type: "start", partial: createPartial() }
        break
      }

      case "content_block_start":
        if (event.content_block.type === "text") {
          contentIndex = event.index
          yield { type: "text_start", contentIndex, partial: createPartial() }
        } else if (event.content_block.type === "tool_use") {
          toolUseIndex = event.index
          yield { type: "toolcall_start", contentIndex: event.index, partial: createPartial() }
        }
        break

      case "content_block_delta":
        if (event.delta.type === "text_delta") {
          yield { type: "text_delta", contentIndex, delta: event.delta.text, partial: createPartial() }
        } else if (event.delta.type === "input_json_delta") {
          yield { type: "toolcall_delta", contentIndex: toolUseIndex, delta: event.delta.partial_json, partial: createPartial() }
        }
        break

      case "content_block_stop":
        if (event.index === toolUseIndex) {
          // Tool call complete — we need the full content block for the ToolCall
          // This is handled by the final message
        } else {
          yield { type: "text_end", contentIndex, content: "", partial: createPartial() }
        }
        break

      case "message_delta":
        outputTokens = event.usage?.output_tokens ?? outputTokens
        break

      case "message_stop":
        const finalMsg = await stream.finalMessage()
        const stopReason = finalMsg?.stop_reason
        // already got finalMsg above
        const toolCalls = finalMsg?.content?.filter(b => b.type === "tool_use") ?? []

        for (const tc of toolCalls) {
          if (tc.type === "tool_use") {
            yield {
              type: "toolcall_end",
              contentIndex: 0,
              toolCall: { type: "toolCall", id: tc.id, name: tc.name, arguments: tc.input as Record<string, unknown> },
              partial: createPartial(),
            }
          }
        }

        yield {
          type: "done",
          reason: stopReason === "tool_use" ? "toolUse" : stopReason === "max_tokens" ? "length" : "stop",
          message: createDoneMessage(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
        }
        break
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function createPartial(): any {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  }
}

function createDoneMessage(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): any {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "",
    usage: {
      input: inputTokens,
      output: outputTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  }
}

// Test-only exports.
export const __anthropicDirectTest = { oaiToAnthropicMessages, oaiContentToBlocks, applyCacheBreakpoints }
