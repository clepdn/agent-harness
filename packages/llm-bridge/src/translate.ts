import type {
  Context,
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  Tool,
} from "@earendil-works/pi-ai"

// ── OAI → pi-ai translation ───────────────────────────────────────────────────

interface OaiMessage {
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
          content: oaiContentToText(msg.content),
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
