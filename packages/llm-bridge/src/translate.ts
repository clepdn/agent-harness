import type {
  Context,
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  Tool,
} from "@earendil-works/pi-ai"

// ── OAI → pi-ai translation ───────────────────────────────────────────────────

export interface OaiMessage {
  role: string
  content?: string | OaiContentPart[] | null
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

/** An OpenAI content part, e.g. `{ type: "text", text }` or `{ type: "image_url", ... }`. */
export interface OaiContentPart {
  type?: string
  text?: string
  image_url?: string | { url?: string; detail?: string }
  [key: string]: unknown
}

/**
 * Extract text from an OpenAI `content` field, which may be a plain string or
 * an array of content parts (`[{ type: "text", text }]`). Clients like pi send
 * the array form, so reading only strings drops the entire message — which
 * makes the upstream reject the request with "at least one message is required".
 */
export function oaiContentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === "object" && typeof (p as OaiContentPart).text === "string"
          ? (p as OaiContentPart).text
          : "",
      )
      .join("")
  }
  return ""
}

/**
 * Parse a data URL (`data:image/jpeg;base64,...`) into its mimeType and base64
 * data components. Returns `null` if the string is not a valid data URL.
 */
function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  return { mimeType: match[1], data: match[2] }
}

/**
 * Convert an OpenAI `content` field into pi-ai content parts, preserving image
 * content. Plain strings become a single text part. Arrays are mapped
 * element-by-element: `{ type: "text" }` → TextContent, `{ type: "image_url" }`
 * → ImageContent (data URL is parsed into mimeType + base64 data).
 *
 * Image parts that cannot be parsed (e.g. non-data URLs) are silently dropped.
 */
export function oaiContentToParts(
  content: unknown,
): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : []
  }
  if (!Array.isArray(content)) return []

  const parts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = []

  for (const p of content) {
    if (!p || typeof p !== "object") continue
    const part = p as OaiContentPart

    if (typeof part.text === "string" && part.text) {
      parts.push({ type: "text", text: part.text })
      continue
    }

    if (part.type === "image_url" && part.image_url) {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url.url
      if (!url) continue
      const parsed = parseDataUrl(url)
      if (parsed) {
        parts.push({ type: "image", data: parsed.data, mimeType: parsed.mimeType })
      }
    }
  }

  return parts
}

interface OaiTool {
  type: string
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export function oaiMessagesToContext(
  messages: OaiMessage[],
  tools?: OaiTool[],
): Context {
  const piMessages: Message[] = []
  let systemPrompt: string | undefined

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
      case "developer":
        systemPrompt = oaiContentToText(msg.content) || undefined
        break

      case "user": {
        piMessages.push({
          role: "user",
          content: oaiContentToParts(msg.content),
          timestamp: Date.now(),
        } as UserMessage)
        break
      }

      case "assistant": {
        const content: AssistantMessage["content"] = []

        // Text content
        const assistantText = oaiContentToText(msg.content)
        if (assistantText) {
          content.push({ type: "text", text: assistantText })
        }

        // Tool calls
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let args: Record<string, unknown> = {}
            try {
              args = JSON.parse(tc.function.arguments)
            } catch {
              args = { _raw: tc.function.arguments }
            }
            content.push({
              type: "toolCall",
              id: tc.id,
              name: tc.function.name,
              arguments: args,
            })
          }
        }

        piMessages.push({
          role: "assistant",
          content: content.length > 0 ? content : [{ type: "text", text: "" }],
          api: "openai-completions",
          provider: "openai",
          model: "bridge",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        } as AssistantMessage)
        break
      }

      case "tool": {
        const content = oaiContentToText(msg.content) || JSON.stringify(msg.content ?? "")
        piMessages.push({
          role: "toolResult",
          toolCallId: msg.tool_call_id ?? "",
          toolName: msg.name ?? "unknown",
          content: [{ type: "text", text: content }],
          isError: false,
          timestamp: Date.now(),
        } as ToolResultMessage)
        break
      }
    }
  }

  const ctx: Context = { messages: piMessages }
  if (systemPrompt) ctx.systemPrompt = systemPrompt

  if (tools && tools.length > 0) {
    ctx.tools = tools.map((t): Tool => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters as any,
    }))
  }

  return ctx
}

// ── pi-ai → OAI SSE translation ───────────────────────────────────────────────

export function oaiSseChunk(
  model: string,
  delta: { content?: string; tool_calls?: Array<{ index: number; id: string; type: string; function: { name: string; arguments: string } }> },
  finishReason: string | null,
): string {
  const chunk = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk" as const,
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}

export function oaiCompletionResponse(
  model: string,
  content: string,
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
  finishReason: string,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): unknown {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: content || null,
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }))
  }

  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage,
  }
}
