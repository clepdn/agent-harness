import type OpenAI from "openai"
import type { AssistantMessage as PiAssistantMessage, Context, ImageContent, TextContent, ThinkingContent, ToolCall as PiToolCall, Usage as PiUsage } from "@earendil-works/pi-ai"
import { imageRootForModelInput } from "../container/index"
import type { Message } from "../types"
import { MODEL } from "./config"

const IMAGE_ROOT_HINT = imageRootForModelInput()

export type NiriTool = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }

export const TOOLS: NiriTool[] = [
  {
    type: "function",
    function: {
      name: "shell",
      description:
        "Execute a bash command in your Linux environment. Stateful — cd, env vars, etc. persist. Stdin is generally attached to the PTY (more natural behavior), but for obviously interactive commands (REPLs, editors, pagers) we may redirect stdin to /dev/null to avoid accidental hangs. Output is automatically capped (default 150 lines, 40 for known-verbose commands like apt/pip/npm). Pass max_lines to override; use 0 for unlimited. You can also pass timeout_ms (default 30000, max 600000).",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          max_lines: {
            type: "integer",
            description: "Maximum lines to return. Defaults to 150 (40 for verbose commands like apt/pip). Use 0 for unlimited.",
          },
          timeout_ms: {
            type: "integer",
            description: "Execution timeout in milliseconds. Defaults to 30000. Max 600000.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file from your Linux environment with optional line-range selection. More token-efficient than shell+cat for large files. Returns content with a header showing the line range and total line count. Supports timeout_ms (default 120000, max 600000).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path to the file." },
          start_line: { type: "integer", description: "First line to read (1-indexed). Defaults to 1." },
          end_line: { type: "integer", description: "Last line to read (inclusive). Defaults to start_line + 99." },
          timeout_ms: { type: "integer", description: "Read timeout in milliseconds. Defaults to 120000. Max 600000." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Edit a file by replacing an exact snippet of text. old_text must match exactly once in the file — precise, safe, and no shell-escaping headaches. Use read_file first if you need to confirm the exact text. Supports timeout_ms (default 120000, max 600000).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path to the file." },
          old_text: { type: "string", description: "The exact text to find and replace. Must appear exactly once in the file." },
          new_text: { type: "string", description: "Replacement text. May be empty to delete old_text." },
          timeout_ms: { type: "integer", description: "Edit timeout in milliseconds. Defaults to 120000. Max 600000." },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_search",
      description:
        "Search indexed long-term memories from core notes, journal entries, and people files. Useful when you want deliberate recall instead of relying only on passive memory injection.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for in long-term memory." },
          limit: { type: "integer", description: "Maximum results to return (default 5, max 10)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_alias",
      description:
        "Manage handle aliases used for memory recall. When you see someone using a Discord/Bluesky handle that you recognize as an existing person in memory, set an alias so future messages from that handle pull the right people/core memories. Example: set @meowskullz = ana so DMs from meowskullz recall ana's people file.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["set", "remove", "list"],
            description: "set links a handle to a canonical name; remove unlinks; list returns all current aliases.",
          },
          handle: { type: "string", description: "The handle to alias, e.g. \"meowskullz\" or \"@meowskullz\". Required for set/remove." },
          canonical: { type: "string", description: "The canonical name the handle maps to, e.g. \"ana\". Required for set; optional for remove." },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "image_tool",
      description: `Attach an image from ${IMAGE_ROOT_HINT} so it is injected as a multimodal user message on the next model turn. Use this after creating/downloading an image with shell.`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: `Absolute image path inside ${IMAGE_ROOT_HINT} (for example ${IMAGE_ROOT_HINT}/screenshot.png).` },
          note: { type: "string", description: "Optional text instruction to accompany the image for the next turn." },
          detail: { type: "string", enum: ["auto", "low", "high"], description: "Vision detail level for the next turn image input." },
          timeout_ms: { type: "integer", description: "Read timeout in milliseconds. Defaults to 120000. Max 600000." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_scan",
      description:
        "Scan configured Discord channels and ingest messages into the local Discord inbox database. Uses DISCORD_SCAN_CHANNEL_IDS by default; pass channel_ids to override.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Per-channel message fetch limit (default 50, max 100)." },
          channel_ids: { type: "array", items: { type: "string" }, description: "Optional channel id list to scan instead of DISCORD_SCAN_CHANNEL_IDS." },
          before_message_id: { type: "string", description: "Optional message id cursor for older backfill scans." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_inbox",
      description: "List Discord inbox items tracked in local state. Default status filter is pending; optionally include seen/acted/ignored.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Maximum rows to return (default 20, max 200)." },
          status: { type: "string", description: "Comma-separated statuses: pending,seen,acted,ignored. Defaults to pending." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_backread",
      description: "Read stored Discord message history for a channel from local state, newest first.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string", description: "Discord channel id." },
          limit: { type: "integer", description: "Maximum rows to return (default 40, max 200)." },
          before_message_id: { type: "string", description: "Optional cursor message id to fetch older rows." },
        },
        required: ["channel_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_mark",
      description: "Set decision state for a Discord inbox item so future scans remember handled/ignored choices.",
      parameters: {
        type: "object",
        properties: {
          item_id: { type: "string", description: "Inbox item id (usually message id)." },
          status: { type: "string", enum: ["pending", "seen", "acted", "ignored"] },
          action: { type: "string", enum: ["none", "replied", "messaged", "dismissed", "noted"] },
          note: { type: "string", description: "Optional decision note." },
        },
        required: ["item_id", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_send",
      description:
        "Send a Discord message. reply_mode=auto sends plain unless conversation continuity is ambiguous, then it uses an explicit reply reference.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string", description: "Target channel id." },
          content: { type: "string", description: "Message content to send." },
          source_item_id: { type: "string", description: "Optional inbox item id to mark as acted after sending." },
          reference_message: { type: "string", description: "Optional specific message to treat as reply target. Provide message content, username (for their latest message), or message id" },
          reply_mode: { type: "string", enum: ["auto", "plain", "explicit"], description: "Reply behavior policy (default auto)." },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_channels",
      description: "List configured Discord channels and DM channels with stored interactions, including id-to-name mapping, guild context, and optional channel notes.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_channel_note",
      description: "Set or clear a persistent note for a Discord channel id. Pass empty note to clear.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string", description: "Discord channel id to annotate." },
          note: { type: "string", description: "Channel-specific note text. Empty string clears it." },
        },
        required: ["channel_id", "note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait",
      description: "Pause and wait for the next incoming message or event. Use this when you've finished what you're doing and want to hear back before continuing.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "wait_then_continue",
      description:
        "Wait for a short delay, then continue to another assistant turn without waiting for a new external event. Use this after a timeout or recoverable tool error when you still want to keep working. Accepts timeout_ms (default 10000, max 600000).",
      parameters: {
        type: "object",
        properties: {
          timeout_ms: { type: "integer", description: "Delay before continuing in milliseconds. Defaults to 10000. Max 600000." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rest",
      description: "Go to sleep and end this session. Call this when you're truly done for now — conversation context will be cleared.",
      parameters: {
        type: "object",
        properties: {
          note: { type: "string", description: "Optional note to yourself about where you left off." },
        },
      },
    },
  },
]

// ── Pi conversion helpers ─────────────────────────────────────────────────────

/**
 * Build a pi-ai Context from the internal OAI-compatible message list.
 * System messages are folded into systemPrompt.
 */
export function buildContext(messages: Message[], tools: NiriTool[]): Context {
  const systemParts: string[] = []
  const piMessages: NonNullable<Context["messages"]> = []

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : ""
      if (text) systemParts.push(text)
      continue
    }

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        piMessages.push({ role: "user", content: msg.content, timestamp: Date.now() })
      } else if (Array.isArray(msg.content)) {
        const parts: (TextContent | ImageContent)[] = []
        for (const p of msg.content as Array<{ type: string; text?: string; image_url?: { url: string } | string }>) {
          if (p.type === "text" && typeof p.text === "string") {
            parts.push({ type: "text", text: p.text })
          } else if (p.type === "image_url") {
            const url = typeof p.image_url === "string" ? p.image_url : (p.image_url?.url ?? "")
            if (url.startsWith("data:")) {
              const semi = url.indexOf(";")
              const comma = url.indexOf(",")
              const mimeType = semi > 5 ? url.slice(5, semi) : "image/jpeg"
              const data = comma >= 0 ? url.slice(comma + 1) : ""
              parts.push({ type: "image", data, mimeType } as ImageContent)
            }
          }
        }
        piMessages.push({ role: "user", content: parts, timestamp: Date.now() })
      }
      continue
    }

    if (msg.role === "assistant") {
      const aMsg = msg as OpenAI.Chat.ChatCompletionAssistantMessageParam & { reasoning_content?: string }
      const content: (TextContent | ThinkingContent | PiToolCall)[] = []
      if (typeof aMsg.reasoning_content === "string" && aMsg.reasoning_content) {
        content.push({ type: "thinking", thinking: aMsg.reasoning_content })
      }
      const text = typeof aMsg.content === "string" ? aMsg.content : ""
      if (text) content.push({ type: "text", text })
      for (const tc of aMsg.tool_calls ?? []) {
        if (tc.type === "function") {
          let args: Record<string, unknown> = {}
          try { args = JSON.parse(tc.function.arguments || "{}") } catch { /* keep empty */ }
          content.push({ type: "toolCall", id: tc.id, name: tc.function.name, arguments: args } as PiToolCall)
        }
      }
      if (content.length === 0) content.push({ type: "text", text: "" })
      piMessages.push({
        role: "assistant",
        content,
        api: "openai-completions",
        provider: "openai",
        model: MODEL,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      } as PiAssistantMessage)
      continue
    }

    if (msg.role === "tool") {
      const tMsg = msg as OpenAI.Chat.ChatCompletionToolMessageParam
      const text = typeof tMsg.content === "string" ? tMsg.content :
        Array.isArray(tMsg.content) ? (tMsg.content as { text?: string }[]).map(p => p.text ?? "").join("") : ""
      piMessages.push({
        role: "toolResult",
        toolCallId: tMsg.tool_call_id,
        toolName: "",
        content: [{ type: "text", text }],
        isError: false,
        timestamp: Date.now(),
      })
    }
  }

  return {
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: piMessages,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: tools.map(t => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters as any })),
  }
}

/** Convert a pi-ai AssistantMessage back to the internal OAI-compatible format. */
export function fromAssistantMessage(
  msg: PiAssistantMessage,
): OpenAI.Chat.ChatCompletionMessage & { reasoning_content?: string } {
  let text = ""
  let reasoning = ""
  const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []

  for (const part of msg.content) {
    if (part.type === "text") text += (part as TextContent).text
    else if (part.type === "thinking") reasoning += (part as ThinkingContent).thinking
    else if (part.type === "toolCall") {
      const tc = part as PiToolCall
      toolCalls.push({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })
    }
  }

  return {
    role: "assistant",
    content: text || null,
    refusal: null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(reasoning ? { reasoning_content: reasoning } : {}),
  }
}

/** Convert pi-ai Usage to OAI CompletionUsage. */
export function fromUsage(usage: PiUsage): OpenAI.Completions.CompletionUsage {
  return { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.totalTokens }
}
