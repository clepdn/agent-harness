// Direct Anthropic API client for subscription (OAuth) models.
// Handles Claude Code identity headers, billing attribution, and OAuth auth.
// Bypasses pi-ai entirely for Anthropic subscription models.

import Anthropic from "@anthropic-ai/sdk"
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { AssistantMessageEvent } from "@earendil-works/pi-ai"

const CLAUDE_CODE_VERSION = "2.1.92"

const OAUTH_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
]

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
  content?: string | null
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
}

interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

function oaiToAnthropicMessages(messages: OaiMessage[]): {
  system: Anthropic.MessageCreateParams["system"]
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
        if (msg.content) {
          systemBlocks.push({ type: "text", text: msg.content })
        }
        break
      }
      case "user": {
        const text = typeof msg.content === "string" ? msg.content : ""
        if (text) userBlocks.push({ type: "text", text })
        break
      }
      case "assistant": {
        flushUserBlocks()
        const blocks: Anthropic.ContentBlockParam[] = []
        if (msg.content) {
          blocks.push({ type: "text", text: msg.content })
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
            content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
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
    { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
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

  for await (const event of stream) {
    switch (event.type) {
      case "message_start":
        inputTokens = event.message.usage?.input_tokens ?? 0
        yield { type: "start", partial: createPartial() }
        break

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
          message: createDoneMessage(inputTokens, outputTokens),
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

function createDoneMessage(inputTokens: number, outputTokens: number): any {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "",
    usage: {
      input: inputTokens,
      output: outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens + outputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  }
}
