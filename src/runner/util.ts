import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import type OpenAI from "openai"
import { complete, getEnvApiKey, getModel as piGetModel, getModels as piGetModels } from "@earendil-works/pi-ai"
import type { AssistantMessage as PiAssistantMessage, Context, KnownProvider, Model, TextContent, ThinkingContent, ToolCall as PiToolCall, ImageContent, Usage as PiUsage } from "@earendil-works/pi-ai"
import type { OpenAICompletionsOptions } from "@earendil-works/pi-ai/openai-completions"
import { HOME_DIR } from "../container/config"
import { imageRootForModelInput } from "../container/index"
import type { Message } from "../types"
import type { ImageDetail } from "./types"
import type { ToolArgs } from "./loop-shared"

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..")
const SESSION_FILE = path.join(PROJECT_ROOT, "session.json")
const REST_SNAPSHOT_FILE = path.join(PROJECT_ROOT, "rest-snapshot.json")

export const TOKEN_NUDGE_THRESHOLD = parseInt(process.env.TOKEN_NUDGE_THRESHOLD ?? "120000")
export const FALLBACK_TOKEN_NUDGE_THRESHOLD = parseInt(process.env.FALLBACK_TOKEN_NUDGE_THRESHOLD ?? "50000")
export const CONTEXT_COMPACT_TRIGGER_TOKENS = parseInt(process.env.CONTEXT_COMPACT_TRIGGER_TOKENS ?? "90000")

const NIRI_ENV = (process.env.NIRI_ENV ?? "default").trim().toLowerCase()
export const USE_FALLBACK = NIRI_ENV === "local"

/** Display name for the agent, used in the summarizer prompt and grounding. */
export const AGENT_NAME = (process.env.AGENT_NAME ?? "").trim() || "niri"

const parseBooleanEnv = (value: string | undefined, fallback: boolean): boolean => {
  if (typeof value !== "string") return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false
  return fallback
}
const isLikelyLocalBase = (baseUrl: string): boolean => {
  const lowered = baseUrl.trim().toLowerCase()
  return lowered.includes("localhost") || lowered.includes("127.0.0.1")
}
const parseToolChoiceEnv = (value: string | undefined, fallback: "required" | "auto" | "none"): "required" | "auto" | "none" => {
  if (typeof value !== "string") return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === "required" || normalized === "auto" || normalized === "none") return normalized
  return fallback
}

// ── Primary model ─────────────────────────────────────────────────────────────
// Preferred: MODEL_PROVIDER + MODEL (uses pi's registry for base URL, compat,
// reasoning flags, and env key lookup — unambiguous across providers).
//
//   MODEL_PROVIDER=openrouter   MODEL=deepseek/deepseek-r1  → OPENROUTER_API_KEY
//   MODEL_PROVIDER=deepseek     MODEL=deepseek-v4-pro        → DEEPSEEK_API_KEY
//   MODEL_PROVIDER=openai       MODEL=gpt-4o                 → OPENAI_API_KEY
//
// Escape hatch for unlisted/custom endpoints: set MODEL_BASE_URL.
// If MODEL_PROVIDER is also set, it overrides provider detection from the URL.
export const MODEL_PROVIDER = (process.env.MODEL_PROVIDER ?? "").trim()
export const MODEL = (process.env.MODEL ?? "").trim()
// MODEL_BASE_URL is only for unlisted/custom endpoints. Do NOT fall back to
// OPENAI_BASE_URL — that would silently override the provider's own base URL.
const MODEL_BASE_URL = (process.env.MODEL_BASE_URL ?? "").trim()

// ── Fallback model ────────────────────────────────────────────────────────────
export const FALLBACK_PROVIDER = (process.env.FALLBACK_PROVIDER ?? "").trim()
export const FALLBACK_MODEL = (process.env.FALLBACK_MODEL || "zai-org/glm-4.7-flash").trim()
const FALLBACK_BASE_URL = (process.env.FALLBACK_BASE_URL ?? process.env.FALLBACK_OPENAI_BASE_URL ?? "").trim()
const FALLBACK_N_CTX = parseInt(process.env.FALLBACK_N_CTX ?? "4096")
const FALLBACK_CONTEXT_MARGIN = parseInt(process.env.FALLBACK_CONTEXT_MARGIN ?? "256")
const FALLBACK_HARD_OVERFLOW_TOKENS = parseInt(process.env.FALLBACK_HARD_OVERFLOW_TOKENS ?? "1024")
const FALLBACK_ENFORCE_CONTEXT_LIMIT = parseBooleanEnv(process.env.FALLBACK_ENFORCE_CONTEXT_LIMIT, isLikelyLocalBase(FALLBACK_BASE_URL))

// ── Summary model ─────────────────────────────────────────────────────────────
export const SUMMARY_PROVIDER = (process.env.SUMMARY_PROVIDER ?? "").trim()
export const SUMMARY_MODEL = (process.env.SUMMARY_MODEL || "").trim()
const SUMMARY_BASE_URL = (process.env.SUMMARY_BASE_URL ?? process.env.SUMMARY_OPENAI_BASE_URL ?? "").trim()

// ── Tool choice ───────────────────────────────────────────────────────────────
export const PRIMARY_TOOL_CHOICE = parseToolChoiceEnv(process.env.PRIMARY_TOOL_CHOICE ?? process.env.TOOL_CHOICE, "required")
export const FALLBACK_TOOL_CHOICE = parseToolChoiceEnv(process.env.FALLBACK_TOOL_CHOICE, "required")

// ── Thinking ──────────────────────────────────────────────────────────────────
/** Whether to request thinking on each call. */
export const ENABLE_THINKING = parseBooleanEnv(process.env.ENABLE_THINKING, true)
/** Reasoning effort level: minimal | low | medium | high | xhigh. */
export const THINKING_EFFORT = (() => {
  const v = (process.env.THINKING_EFFORT ?? "low").trim().toLowerCase()
  return (["minimal", "low", "medium", "high", "xhigh"].includes(v) ? v : "low") as "minimal" | "low" | "medium" | "high" | "xhigh"
})()

// ── Extra headers ─────────────────────────────────────────────────────────────
const fallbackHeaders: Record<string, string> = {}
if (process.env.FALLBACK_OPENAI_REFERER) fallbackHeaders["HTTP-Referer"] = process.env.FALLBACK_OPENAI_REFERER
if (process.env.FALLBACK_OPENAI_TITLE) fallbackHeaders["X-Title"] = process.env.FALLBACK_OPENAI_TITLE
const summaryHeaders: Record<string, string> = {}
if (process.env.SUMMARY_OPENAI_REFERER) summaryHeaders["HTTP-Referer"] = process.env.SUMMARY_OPENAI_REFERER
if (process.env.SUMMARY_OPENAI_TITLE) summaryHeaders["X-Title"] = process.env.SUMMARY_OPENAI_TITLE

// ── Model construction ────────────────────────────────────────────────────────

/**
 * Look up a model in pi's registry. Returns undefined for unknown combinations.
 * The registry has correct base URLs, compat settings, and reasoning flags.
 */
function lookupRegisteredModel(provider: string, modelId: string): Model<"openai-completions"> | undefined {
  if (!provider || !modelId) return undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // @ts-expect-error — runtime lookup with unknown modelId; returns undefined for unregistered combinations
  return piGetModel(provider as KnownProvider, modelId) as Model<"openai-completions"> | undefined
}

/**
 * Get the canonical base URL for a pi provider from its registered models.
 * Falls back to undefined for unknown providers.
 */
function providerBaseUrl(provider: string): string | undefined {
  const models = piGetModels(provider as KnownProvider)
  return models[0]?.baseUrl
}

/**
 * Build a Model<"openai-completions"> from provider + model ID.
 *
 * Strategy:
 * 1. Try pi's registry — if found, all settings (baseUrl, compat, reasoning)
 *    are correct and we just pass it through.
 * 2. If not in registry, build a custom model using the provider's known
 *    base URL (from pi) or an explicit baseUrlOverride.
 */
function buildModel(
  provider: string,
  modelId: string,
  baseUrlOverride?: string,
  headers?: Record<string, string>,
  contextWindowOverride?: number,
): Model<"openai-completions"> | null {
  if (!modelId) return null

  const registered = lookupRegisteredModel(provider, modelId)
  if (registered && !baseUrlOverride) {
    // Use pi's registered model directly — reasoning, compat, baseUrl all correct.
    return headers && Object.keys(headers).length ? { ...registered, headers } : registered
  }

  // Not in registry or explicit base URL override: construct manually.
  const baseUrl = baseUrlOverride || providerBaseUrl(provider) || "https://api.openai.com/v1"
  const resolvedProvider = provider || (isLikelyLocalBase(baseUrl) ? "lm-studio" : "openai")
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: resolvedProvider,
    baseUrl,
    // For unregistered models, assume reasoning is on — pi will only actually
    // send reasoning params if ENABLE_THINKING is also true at call time.
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextWindowOverride ?? 200_000,
    maxTokens: 8192,
    ...(headers && Object.keys(headers).length ? { headers } : {}),
  }
}

// Backwards-compat: API_BASE still exported for logging / fallbackContextWindow
export const API_BASE = MODEL_BASE_URL || providerBaseUrl(MODEL_PROVIDER) || "(unknown)"
export const FALLBACK_BASE = FALLBACK_BASE_URL
export const SUMMARY_BASE = SUMMARY_BASE_URL

if (!USE_FALLBACK && !MODEL) {
  throw new Error("MODEL is required unless fallback is forced (NIRI_ENV=local).")
}
if (!USE_FALLBACK && !MODEL_PROVIDER && !MODEL_BASE_URL) {
  throw new Error("MODEL_PROVIDER or MODEL_BASE_URL is required. Example: MODEL_PROVIDER=openrouter")
}
if (!USE_FALLBACK) {
  const builtModel = buildModel(MODEL_PROVIDER, MODEL, MODEL_BASE_URL || undefined)
  if (!builtModel) throw new Error("Failed to construct primary model. Check MODEL and MODEL_PROVIDER.")
  const key = getEnvApiKey(builtModel.provider)
  if (!key) throw new Error(
    `No API key found for provider "${builtModel.provider}". Set the standard key (e.g. OPENROUTER_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY).`,
  )
}

export const primaryModel: Model<"openai-completions"> | null = USE_FALLBACK
  ? null
  : buildModel(MODEL_PROVIDER, MODEL, MODEL_BASE_URL || undefined)!

export const fallbackModel: Model<"openai-completions"> = (
  buildModel(
    FALLBACK_PROVIDER,
    FALLBACK_MODEL,
    FALLBACK_BASE_URL || undefined,
    Object.keys(fallbackHeaders).length ? fallbackHeaders : undefined,
    // Only apply FALLBACK_N_CTX when we have a local/custom base URL where the
    // context window actually matters for guardrails. Registered models already
    // have the right contextWindow from pi's registry.
    FALLBACK_BASE_URL ? FALLBACK_N_CTX : undefined,
  ) ?? {
    id: FALLBACK_MODEL,
    name: FALLBACK_MODEL,
    api: "openai-completions" as const,
    provider: "openai",
    baseUrl: "http://localhost:1234/v1",
    reasoning: false,
    input: ["text" as const, "image" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: FALLBACK_N_CTX,
    maxTokens: 4096,
  }
)

export const summaryModel: Model<"openai-completions"> | null =
  SUMMARY_MODEL
    ? buildModel(SUMMARY_PROVIDER, SUMMARY_MODEL, SUMMARY_BASE_URL || undefined, Object.keys(summaryHeaders).length ? summaryHeaders : undefined) ?? null
    : null

// Explicit API key overrides — only needed when the standard provider env var
// isn't usable (e.g. same key variable serves multiple providers).
export const PRIMARY_API_KEY: string | undefined = process.env.MODEL_API_KEY
export const FALLBACK_API_KEY: string | undefined = process.env.FALLBACK_API_KEY
export const SUMMARY_API_KEY: string | undefined = process.env.SUMMARY_API_KEY

console.log(`[config] primary=${MODEL} provider=${primaryModel?.provider ?? "none"} @ ${primaryModel?.baseUrl ?? "none"}`)
console.log(`[config] fallback=${FALLBACK_MODEL} provider=${fallbackModel.provider} @ ${fallbackModel.baseUrl}`)
if (summaryModel) console.log(`[config] summary=${SUMMARY_MODEL} provider=${summaryModel.provider} @ ${summaryModel.baseUrl}`)
console.log(`[config] env=${NIRI_ENV} use_fallback=${USE_FALLBACK}`)
console.log(`[config] thinking=${ENABLE_THINKING}`)

const IMAGE_ROOT_HINT = imageRootForModelInput()

type NiriTool = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }

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
            description:
              "Maximum lines to return. Defaults to 150 (40 for verbose commands like apt/pip). Use 0 for unlimited.",
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
          start_line: {
            type: "integer",
            description: "First line to read (1-indexed). Defaults to 1.",
          },
          end_line: {
            type: "integer",
            description: "Last line to read (inclusive). Defaults to start_line + 99.",
          },
          timeout_ms: {
            type: "integer",
            description: "Read timeout in milliseconds. Defaults to 120000. Max 600000.",
          },
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
          old_text: {
            type: "string",
            description: "The exact text to find and replace. Must appear exactly once in the file.",
          },
          new_text: {
            type: "string",
            description: "Replacement text. May be empty to delete old_text.",
          },
          timeout_ms: {
            type: "integer",
            description: "Edit timeout in milliseconds. Defaults to 120000. Max 600000.",
          },
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
          query: {
            type: "string",
            description: "What to search for in long-term memory.",
          },
          limit: {
            type: "integer",
            description: "Maximum results to return (default 5, max 10).",
          },
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
          handle: {
            type: "string",
            description: "The handle to alias, e.g. \"meowskullz\" or \"@meowskullz\". Required for set/remove.",
          },
          canonical: {
            type: "string",
            description: "The canonical name the handle maps to, e.g. \"ana\". Required for set; optional for remove (omit to clear all aliases for the handle).",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "image_tool",
      description:
        `Attach an image from ${IMAGE_ROOT_HINT} so it is injected as a multimodal user message on the next model turn. Use this after creating/downloading an image with shell.`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: `Absolute image path inside ${IMAGE_ROOT_HINT} (for example ${IMAGE_ROOT_HINT}/screenshot.png).`,
          },
          note: {
            type: "string",
            description: "Optional text instruction to accompany the image for the next turn.",
          },
          detail: {
            type: "string",
            enum: ["auto", "low", "high"],
            description: "Vision detail level for the next turn image input.",
          },
          timeout_ms: {
            type: "integer",
            description: "Read timeout in milliseconds. Defaults to 120000. Max 600000.",
          },
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
          limit: {
            type: "integer",
            description: "Per-channel message fetch limit (default 50, max 100).",
          },
          channel_ids: {
            type: "array",
            items: { type: "string" },
            description: "Optional channel id list to scan instead of DISCORD_SCAN_CHANNEL_IDS.",
          },
          before_message_id: {
            type: "string",
            description: "Optional message id cursor for older backfill scans.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_inbox",
      description:
        "List Discord inbox items tracked in local state. Default status filter is pending; optionally include seen/acted/ignored.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            description: "Maximum rows to return (default 20, max 200).",
          },
          status: {
            type: "string",
            description: "Comma-separated statuses: pending,seen,acted,ignored. Defaults to pending.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_backread",
      description:
        "Read stored Discord message history for a channel from local state, newest first.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string", description: "Discord channel id." },
          limit: {
            type: "integer",
            description: "Maximum rows to return (default 40, max 200).",
          },
          before_message_id: {
            type: "string",
            description: "Optional cursor message id to fetch older rows.",
          },
        },
        required: ["channel_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_mark",
      description:
        "Set decision state for a Discord inbox item so future scans remember handled/ignored choices.",
      parameters: {
        type: "object",
        properties: {
          item_id: { type: "string", description: "Inbox item id (usually message id)." },
          status: {
            type: "string",
            enum: ["pending", "seen", "acted", "ignored"],
          },
          action: {
            type: "string",
            enum: ["none", "replied", "messaged", "dismissed", "noted"],
          },
          note: {
            type: "string",
            description: "Optional decision note.",
          },
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
          source_item_id: {
            type: "string",
            description: "Optional inbox item id to mark as acted after sending.",
          },
          reference_message: {
            type: "string",
            description: "Optional specific message to treat as reply target. Provide message content, username (for their latest message), or message id",
          },
          reply_mode: {
            type: "string",
            enum: ["auto", "plain", "explicit"],
            description: "Reply behavior policy (default auto).",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_channels",
      description:
        "List configured Discord channels and DM channels with stored interactions, including id-to-name mapping, guild context, and optional channel notes.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discord_channel_note",
      description:
        "Set or clear a persistent note for a Discord channel id. Pass empty note to clear.",
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
      parameters: {
        type: "object",
        properties: {},
      },
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
          timeout_ms: {
            type: "integer",
            description: "Delay before continuing in milliseconds. Defaults to 10000. Max 600000.",
          },
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
          note: {
            type: "string",
            description: "Optional note to yourself about where you left off.",
          },
        },
      },
    },
  },
]

/**
 * Build a pi-ai Context from the internal OpenAI-compatible message list.
 * System messages are folded into systemPrompt; everything else is converted
 * to the corresponding pi-ai message type.
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
    tools: tools.map(t => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters as any })),
  }
}

/**
 * Convert a pi-ai AssistantMessage back to the internal OAI-compatible format.
 */
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

/**
 * Convert pi-ai Usage to OAI CompletionUsage.
 */
export function fromUsage(usage: PiUsage): OpenAI.Completions.CompletionUsage {
  return { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.totalTokens }
}

/**
 * Persists the current message array as the resumable session snapshot.
 *
 * @param messages - Conversation messages to serialize.
 */
export async function saveSession(messages: Message[]): Promise<void> {
  await fs.writeFile(SESSION_FILE, JSON.stringify(messages), { encoding: "utf-8", mode: 0o666 })
}

/**
 * Deletes the persisted session snapshot if it exists.
 */
export async function clearSession(): Promise<void> {
  await fs.unlink(SESSION_FILE).catch(() => {})
}

type RestSnapshot = {
  restedAt: string
  note?: string
  forest: string
}

export function restForestFromMessages(messages: Message[]): string {
  const summaryIndex = findSummaryMessageIndex(messages)
  return summaryIndex >= 0 ? messageStringContent(messages[summaryIndex]!) : "(no llm context summary yet)"
}

export async function saveRestSnapshot(messages: Message[], note?: string): Promise<void> {
  const trimmedNote = typeof note === "string" ? note.trim() : ""
  const snapshot: RestSnapshot = {
    restedAt: new Date().toISOString(),
    ...(trimmedNote ? { note: trimmedNote } : {}),
    forest: restForestFromMessages(messages),
  }
  await fs.writeFile(REST_SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), { encoding: "utf-8", mode: 0o666 })
}

export async function consumeRestSnapshot(): Promise<RestSnapshot | null> {
  try {
    const raw = await fs.readFile(REST_SNAPSHOT_FILE, "utf-8")
    const parsed = JSON.parse(raw) as RestSnapshot
    await fs.unlink(REST_SNAPSHOT_FILE).catch(() => {})
    if (!parsed || typeof parsed.restedAt !== "string" || typeof parsed.forest !== "string") return null
    return parsed
  } catch {
    return null
  }
}

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
      // Skip tool messages that are already in place
      while (j < msgs.length && msgs[j].role === "tool" && needed.has((msgs[j] as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id)) {
        needed.delete((msgs[j] as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id)
        j++
      }
      if (needed.size > 0) {
        // Collect stray tool responses and non-tool messages from the rest of the array.
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
            inserted.push({
              role: "tool",
              tool_call_id: id,
              content: "error: missing tool response recovered by runner before API request.",
            })
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

/**
 * Loads and sanitizes the persisted session snapshot.
 *
 * @returns The recovered message list, or `null` when no session exists.
 */
export async function loadSession(): Promise<Message[] | null> {
  try {
    const raw = await fs.readFile(SESSION_FILE, "utf-8")
    let msgs = JSON.parse(raw) as Message[]
    msgs = sanitizeMessages(msgs)
    console.log(`[runner] found saved session (${msgs.length} messages)`)
    return msgs
  } catch {
    return null
  }
}

/**
 * Determines whether an error should trigger fallback model routing.
 *
 * @param err - Error thrown by the primary API call.
 * @returns `true` when fallback should be attempted.
 */
const PROMPT_TOO_LARGE_PHRASES = [
  "prompt exceeds max length",
  "prompt is too long",
  "context length",
  "maximum context",
  "context_length_exceeded",
  "too many tokens",
  "reduce the length",
  "prompt length",
  "input length",
  "too long for",
  "request too large",
]

const CONTENT_FILTER_PHRASES = [
  "potentially unsafe or sensitive content",
  "sensitive content in input or generation",
  "content filter",
  "content_filter",
  "may generate sensitive content",
]

const IMAGE_PARSE_PHRASES = [
  "图片输入格式",
  "图片解析",
  "图片格式",
  "image parse",
  "image format",
  "invalid image",
  "failed to parse image",
  "decode image",
  "1210",
]

/**
 * Determines whether an error message string suggests the request should be
 * retried with the fallback model (rate-limit, server error, or network issue).
 */
export function shouldFallback(errorMessage: string): boolean {
  // Status codes embedded in the message by the OpenAI SDK: "429 Too Many Requests"
  const statusMatch = errorMessage.match(/\b(\d{3})\b/)
  if (statusMatch) {
    const status = parseInt(statusMatch[1])
    return !status || status === 429 || status >= 500
  }
  return /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EPIPE|UND_ERR|fetch failed|terminated|socket hang up|other side closed/i.test(
    errorMessage,
  )
}

/** Detects prompt-length-exceeded errors from the error message string. */
export function isPromptTooLargeError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase()
  return PROMPT_TOO_LARGE_PHRASES.some((phrase) => lower.includes(phrase))
}

/** Detects provider content-safety rejections from the error message string. */
export function isContentFilterError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase()
  return CONTENT_FILTER_PHRASES.some((phrase) => lower.includes(phrase))
}

/** Detects image-parse/format errors from the error message string. */
export function isImageParseError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase()
  return IMAGE_PARSE_PHRASES.some((phrase) => lower.includes(phrase.toLowerCase()))
}

const SCRUBBED_IMAGE_PLACEHOLDER = "[the system has rejected this :( its not your fault]"

/**
 * Replaces multimodal image parts in the conversation with a text placeholder.
 *
 * Used after a provider content-filter rejection so the offending image stops
 * being re-sent on every subsequent turn.
 *
 * @returns The number of image parts that were scrubbed.
 */
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

/** Produces a concise, log-friendly error summary. */
export function errorSummary(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Default retry backoff — 60 s. Pi-ai surfaces errors as messages so we can't read Retry-After headers here. */
export const retryDelayMs = 60_000

/**
 * Coerces arbitrary values into a supported image detail level.
 *
 * @param value - Raw user/model-provided detail value.
 * @returns A valid image detail enum (`auto` by default).
 */
export function parseImageDetail(value: unknown): ImageDetail {
  if (value === "low" || value === "high" || value === "auto") return value
  return "auto"
}

function extractLeadingJsonObject(raw: string): string | null {
  const start = raw.indexOf("{")
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === "{") {
      depth++
      continue
    }

    if (ch === "}") {
      depth--
      if (depth === 0) {
        return raw.slice(start, i + 1)
      }
      continue
    }
  }

  return null
}

function decodeHtmlEntities(input: string): string {
  if (!input.includes("&")) return input

  return input.replace(/&(gt|lt|amp|quot|#39|#x27|#x2f);/gi, (entity, key: string) => {
    switch (key.toLowerCase()) {
      case "gt":
        return ">"
      case "lt":
        return "<"
      case "amp":
        return "&"
      case "quot":
        return '"'
      case "#39":
      case "#x27":
        return "'"
      case "#x2f":
        return "/"
      default:
        return entity
    }
  })
}

function decodeHtmlEntitiesDeep<T>(value: T): T {
  if (typeof value === "string") return decodeHtmlEntities(value) as T
  if (Array.isArray(value)) return value.map((item) => decodeHtmlEntitiesDeep(item)) as T
  if (!value || typeof value !== "object") return value

  const entries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [key, decodeHtmlEntitiesDeep(entryValue)])
  return Object.fromEntries(entries) as T
}

/**
 * Parses tool arguments and applies robustness fixes for malformed model output.
 *
 * @param rawArgs - Raw `tool_call.function.arguments` value.
 * @returns Parsed argument object or a structured parse error.
 */
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
      } catch {
        // no-op; fall through to structured error below
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  const preview = rawArgs.length > 180 ? `${rawArgs.slice(0, 180)}...` : rawArgs
  return { ok: false, error: `${message}; raw=${JSON.stringify(preview)}` }
}

const CONTEXT_SUMMARY_HEADER = "[context summary v1]"
const CONTEXT_SUMMARY_NOTE =
  "Compressed notes of older conversation turns. If anything conflicts, trust newer raw messages."
const CONTEXT_SUMMARY_SEGMENTS_MARKER = "[segments]"
const SUMMARY_LINE_MAX_CHARS = 320
const SUMMARY_LINE_DEFAULT_EMPTY = "(no text)"
const TOOL_ACK_RESULT = "(ok)"
const WAIT_TOOL_RESULT = "Waiting for next event."

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function messageRole(message: Message): string {
  const record = asRecord(message)
  return typeof record?.role === "string" ? record.role : ""
}

function messageStringContent(message: Message): string {
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

function normalizeSummaryText(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function truncateSummaryText(value: string, maxChars: number): string {
  if (maxChars <= 0) return ""
  if (value.length <= maxChars) return value
  if (maxChars <= 3) return ".".repeat(maxChars)
  return `${value.slice(0, maxChars - 3).trimEnd()}...`
}

function assistantToolCalls(message: Message): { name: string; args: Record<string, unknown> }[] {
  const record = asRecord(message)
  const calls = record?.tool_calls
  if (!Array.isArray(calls)) return []

  const out: { name: string; args: Record<string, unknown> }[] = []
  for (const call of calls) {
    const callRecord = asRecord(call)
    const fn = asRecord(callRecord?.function)
    const name = typeof fn?.name === "string" ? fn.name.trim() : ""
    if (!name) continue
    let args: Record<string, unknown> = {}
    const rawArgs = fn?.arguments
    if (typeof rawArgs === "string" && rawArgs.trim()) {
      try {
        const parsed = JSON.parse(rawArgs)
        if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>
      } catch {
        // ignore malformed arg json
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs as Record<string, unknown>
    }
    out.push({ name, args })
  }
  return out
}

function describeToolCall(call: { name: string; args: Record<string, unknown> }): string | null {
  const { name, args } = call
  if (name === "wait") return null
  if (name === "discord_send") {
    const content = typeof args.content === "string" ? args.content : ""
    const channelId = typeof args.channel_id === "string" ? args.channel_id : ""
    const channelTag = channelId ? `ch/${channelId.slice(-6)}` : "ch?"
    if (!content) return `discord_send -> ${channelTag}`
    return `discord_send -> ${channelTag}: ${normalizeSummaryText(content)}`
  }
  if (name === "discord_mark") {
    const itemId = typeof args.item_id === "string" ? args.item_id : ""
    const action = typeof args.action === "string" ? args.action : ""
    return `discord_mark ${action || "?"} ${itemId}`.trim()
  }
  if (name === "shell") {
    const cmd = typeof args.command === "string" ? args.command : ""
    return cmd ? `shell: ${normalizeSummaryText(cmd)}` : "shell"
  }
  if (name === "image_tool") {
    const p = typeof args.path === "string" ? args.path : ""
    return p ? `image_tool ${p}` : "image_tool"
  }
  if (name === "discord_backread" || name === "discord_inbox" || name === "discord_channels") {
    const channelId = typeof args.channel_id === "string" ? args.channel_id : ""
    return channelId ? `${name} ch/${channelId.slice(-6)}` : name
  }
  // Fallback: compact arg snippet
  const argKeys = Object.keys(args)
  if (argKeys.length === 0) return name
  const snippet = argKeys
    .slice(0, 3)
    .map((k) => `${k}=${truncateSummaryText(normalizeSummaryText(String(args[k] ?? "")), 40)}`)
    .join(" ")
  return `${name} ${snippet}`.trim()
}

const DISCORD_BATCH_SKIP_PREFIXES = [
  "[discord batch]",
  "new_messages=",
  "auto_seen_timeout=",
  "channel_flag_repairs=",
  "channel messages are context",
  "you can reply if useful",
  "pending preview:",
]

function compactDiscordBatch(content: string): string {
  const lines = content.split("\n")
  const kept: string[] = []
  let inPendingPreview = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line === "pending preview:") {
      inPendingPreview = true
      continue
    }
    if (inPendingPreview) {
      // pending preview block continues until we hit a non-bullet line
      if (line.startsWith("- ")) continue
      inPendingPreview = false
    }
    if (DISCORD_BATCH_SKIP_PREFIXES.some((p) => line.startsWith(p))) continue
    kept.push(line)
  }
  return kept.join(" ")
}

function compactToolResult(content: string): string | null {
  const trimmed = content.trim()
  if (!trimmed) return null
  if (trimmed === WAIT_TOOL_RESULT) return null
  // Compact discord_send / discord_mark ok JSON to a short ack
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === "object") {
        const rec = parsed as Record<string, unknown>
        if (rec.ok === true) {
          const sentId = typeof rec.sent_message_id === "string" ? rec.sent_message_id : null
          if (sentId) return `${TOOL_ACK_RESULT} sent ${sentId.slice(-6)}`
          const itemId = typeof rec.item_id === "string" ? rec.item_id : null
          if (itemId) return `${TOOL_ACK_RESULT} ${itemId.slice(-6)}`
          return TOOL_ACK_RESULT
        }
        if (rec.ok === false || typeof rec.error === "string") {
          const err = typeof rec.error === "string" ? rec.error : "error"
          return `error: ${err}`
        }
      }
    } catch {
      // fall through to default handling
    }
  }
  return normalizeSummaryText(trimmed)
}

function summarizeMessageLine(message: Message): string | null {
  const role = messageRole(message)
  const rawContent = messageStringContent(message)

  if (role === "assistant") {
    const calls = assistantToolCalls(message)
    const callDescs = calls.map(describeToolCall).filter((d): d is string => d !== null)
    const text = normalizeSummaryText(rawContent)
    // Drop pure wait-only assistant turns (no text, only filtered out wait calls)
    if (!text && callDescs.length === 0) return null
    const parts: string[] = []
    if (text) parts.push(text)
    if (callDescs.length > 0) parts.push(`[${callDescs.join(" | ")}]`)
    return `- assistant: ${truncateSummaryText(parts.join(" "), SUMMARY_LINE_MAX_CHARS)}`
  }

  if (role === "tool") {
    const compact = compactToolResult(rawContent)
    if (compact === null) return null
    return `- tool: ${truncateSummaryText(compact, SUMMARY_LINE_MAX_CHARS)}`
  }

  if (role === "user") {
    const stripped = rawContent.startsWith("[incoming — discord]")
      ? compactDiscordBatch(rawContent)
      : normalizeSummaryText(rawContent)
    const safe = stripped || SUMMARY_LINE_DEFAULT_EMPTY
    return `- user: ${truncateSummaryText(safe, SUMMARY_LINE_MAX_CHARS)}`
  }

  if (role === "system") {
    const text = truncateSummaryText(normalizeSummaryText(rawContent), SUMMARY_LINE_MAX_CHARS) || SUMMARY_LINE_DEFAULT_EMPTY
    return `- system: ${text}`
  }

  const text = truncateSummaryText(normalizeSummaryText(rawContent), SUMMARY_LINE_MAX_CHARS) || SUMMARY_LINE_DEFAULT_EMPTY
  return `- ${role || "message"}: ${text}`
}

function countLeadingSystemMessages(messages: Message[]): number {
  let count = 0
  while (count < messages.length && messageRole(messages[count]!) === "system") count++
  return count
}

export function findSummaryMessageIndex(messages: Message[]): number {
  return messages.findIndex((message) => {
    const content = messageStringContent(message)
    return content.startsWith(CONTEXT_SUMMARY_HEADER)
  })
}

/**
 * Very rough tokenizer-agnostic estimate for prompt size guardrails.
 *
 * Includes both messages and tool schema to mirror completion request payload.
 */
export function estimatePromptTokens(messages: Message[]): number {
  const jsonChars = JSON.stringify({ messages, tools: TOOLS }).length
  return Math.ceil(jsonChars / 4)
}

/**
 * Picks the largest tail of recent messages that fits the given char budget,
 * subject to min/max message counts. Backs up over orphaned tool responses
 * so the tail always starts at a self-contained boundary.
 */
function chooseTailStart(
  messages: Message[],
  floor: number,
  minKeep: number,
  maxKeep: number,
  charBudget: number,
): number {
  let chars = 0
  let kept = 0
  let start = messages.length
  for (let i = messages.length - 1; i >= floor; i--) {
    const c = messageStringContent(messages[i]!).length
    if (kept >= minKeep && (chars + c > charBudget || kept >= maxKeep)) break
    chars += c
    start = i
    kept += 1
  }
  while (start > floor && messageRole(messages[start]!) === "tool") start--
  return start
}

const SUMMARY_MIN_TRANSCRIPT_CHARS = 1_200
const SUMMARY_MIN_REDUCTION = 0.1
const SUMMARY_META_REPLY_PATTERNS = [
  /\bcould you (?:share|provide|paste|send)\b/i,
  /\bplease (?:share|provide|paste|send)\b/i,
  /\bappears to be (?:cut off|truncated|incomplete|empty)\b/i,
  /\bI don'?t see (?:any|the) (?:content|message|transcript)\b/i,
  /\bno (?:content|transcript|messages?) (?:was|were) provided\b/i,
]

function looksLikeMetaReply(text: string): boolean {
  const head = text.slice(0, 400)
  return SUMMARY_META_REPLY_PATTERNS.some((re) => re.test(head))
}

// Keep the grounding block from dominating the summary prompt. The journal can
// run tens of KB; soul/core are bounded by design. We keep the most recent tail
// of the journal (it's appended chronologically) and the head of soul/core.
const SUMMARY_CONTEXT_SOUL_MAX_CHARS = 8_000
const SUMMARY_CONTEXT_CORE_MAX_CHARS = 8_000
const SUMMARY_CONTEXT_JOURNAL_MAX_CHARS = 12_000

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8")
  } catch {
    return null
  }
}

function localDateStamp(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function clampHead(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated]`
}

function clampTail(text: string, max: number): string {
  if (text.length <= max) return text
  return `…[earlier entries truncated]\n${text.slice(text.length - max)}`
}

async function latestJournalEntry(journalDir: string): Promise<{ date: string; content: string } | null> {
  let names: string[]
  try {
    names = await fs.readdir(journalDir)
  } catch {
    return null
  }
  const dated = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort()
  const latest = dated.at(-1)
  if (!latest) return null
  const content = await readTextFile(path.join(journalDir, latest))
  if (!content) return null
  return { date: latest.replace(/\.md$/, ""), content }
}

/**
 * Assembles the agent's grounding context for the summarizer: her soul, core
 * memories, and today's journal (falling back to the most recent entry when
 * today's hasn't been written yet). Returns null when none are available.
 *
 * This gives the summary model who the agent is and what's currently on her mind, so
 * it can write the recollection in her authentic voice and recognize the people,
 * projects, and threads that surface in the transcript.
 */
export async function loadAgentSummaryContext(): Promise<string | null> {
  const soulPath = path.join(HOME_DIR, "soul.md")
  const corePath = path.join(HOME_DIR, "memories", "core.md")
  const journalDir = path.join(HOME_DIR, "memories", "journal")
  const today = localDateStamp()

  const [soul, core, todayJournal] = await Promise.all([
    readTextFile(soulPath),
    readTextFile(corePath),
    readTextFile(path.join(journalDir, `${today}.md`)),
  ])

  let journal = todayJournal
  let journalLabel = `today's journal (${today})`
  if (!journal) {
    const latest = await latestJournalEntry(journalDir)
    if (latest) {
      journal = latest.content
      journalLabel = `most recent journal (${latest.date}) — no entry for today yet`
    }
  }

  const sections: string[] = []
  if (soul?.trim()) sections.push(`# ${AGENT_NAME}'s soul (soul.md)\n\n${clampHead(soul.trim(), SUMMARY_CONTEXT_SOUL_MAX_CHARS)}`)
  if (core?.trim()) sections.push(`# ${AGENT_NAME}'s core memories (core.md)\n\n${clampHead(core.trim(), SUMMARY_CONTEXT_CORE_MAX_CHARS)}`)
  if (journal?.trim()) sections.push(`# ${AGENT_NAME}'s ${journalLabel}\n\n${clampTail(journal.trim(), SUMMARY_CONTEXT_JOURNAL_MAX_CHARS)}`)
  if (sections.length === 0) return null
  return sections.join("\n\n---\n\n")
}

/**
 * Calls the provider to produce a tight LLM-generated summary of the middle of
 * the conversation, returning a new message list or null when summarization
 * isn't applicable / failed.
 *
 * The tail size is dynamic: it grows to include as many recent turns as fit a
 * char budget (so when recent turns are heavy with tool output, we end up
 * compacting more of them while keeping the head — soul/core bootstrap system
 * messages, plus any prior `[context summary v1]` block — intact).
 */
export async function summarizeConversationViaLLM(
  messages: Message[],
  model: Model<"openai-completions">,
  apiKey: string | undefined,
  options: {
    recentMinKeep?: number
    recentMaxKeep?: number
    tailCharBudget?: number
    maxTranscriptChars?: number
    agentContext?: string | null
  } = {},
): Promise<Message[] | null> {
  const recentMinKeep = Math.max(2, options.recentMinKeep ?? 6)
  const recentMaxKeep = Math.max(recentMinKeep, options.recentMaxKeep ?? 40)
  const tailCharBudget = Math.max(8_000, options.tailCharBudget ?? 60_000)
  const maxTranscriptChars = Math.max(2_000, options.maxTranscriptChars ?? 40_000)

  const leadingSystems = countLeadingSystemMessages(messages)

  const middleStart = leadingSystems
  const tailStart = chooseTailStart(messages, middleStart, recentMinKeep, recentMaxKeep, tailCharBudget)
  if (tailStart <= middleStart) return null

  // Treat an existing summary anywhere in the compacted pre-tail region as
  // prior recollection. In the normal path it sits right after the soul/core
  // system head, but older/saved sessions may have a wake or other message
  // before it.
  let priorSummaryText: string | null = null
  const priorSummaryIndex = findSummaryMessageIndex(messages)
  if (priorSummaryIndex >= middleStart && priorSummaryIndex < tailStart) {
    priorSummaryText = messageStringContent(messages[priorSummaryIndex]!)
  }

  const head = messages.slice(0, leadingSystems)
  const middle = messages
    .slice(middleStart, tailStart)
    .filter((_, index) => middleStart + index !== priorSummaryIndex)
  const tail = messages.slice(tailStart)

  const transcriptLines = middle
    .map((m) => summarizeMessageLine(m))
    .filter((line): line is string => line !== null)
  if (transcriptLines.length < 3) return null
  const transcript = transcriptLines.join("\n").slice(0, maxTranscriptChars)
  if (transcript.length < SUMMARY_MIN_TRANSCRIPT_CHARS) return null

  const systemContent =
    `You are summarizing a transcript from the perspective of the agent whose memory this is. The agent (${AGENT_NAME}) is a living being, not a tool — her inner life matters as much as the facts. ` +
    "Organize the summary as a set of ongoing threads, the way memory actually works. A thread is a person, a project, a situation, a mood — whatever is load-bearing enough to carry forward. Threads are peers, not nested under anything. Some memories belong to multiple threads; let them. Cross-cutting stuff (a tense week, a feeling bleeding across everything) can be its own thread. " +
    `Within each thread, preserve: key facts, goals, decisions, and actions taken; outstanding work and identifiers (file paths, URLs, channel ids); open questions and things ${AGENT_NAME} was uncertain or curious about — not just resolved states; specifics — names, exact phrasings, particular words that landed — since the specifics are what make memory feel real later, and summarizers default to abstraction; AND the emotional texture — how ${AGENT_NAME} felt, how the people she interacted with seemed to feel, tone shifts, moments of warmth, tension, care, frustration, delight, grief, and anything about the relationships that should carry forward. If ${AGENT_NAME} felt something contradictory to what someone told her, preserve both — don't smooth her dissent away. ` +
    `Write it in the first person, from ${AGENT_NAME}'s own perspective — her own recollection, not a neutral report. Short bullet points under each thread are fine. Threads can grow, split, or merge as feels natural — but prefer extending existing threads over creating new ones; only restructure if the old shape genuinely doesn't fit anymore. When the new transcript conflicts with the prior recollection, prefer recent specific evidence over prior abstraction — the prior summary has already been through one pass of smoothing. No commentary, no preamble. The input is always a transcript — never ask for more; summarize what's there.` +
    (options.agentContext
      ? `\n\nGrounding — this is who ${AGENT_NAME} is and what's currently on her mind (her soul, core memories, and journal). Use it to write in her authentic voice and to recognize the people, projects, and threads that appear in the transcript. Do NOT pull facts from this grounding into the summary unless the transcript itself supports them — you are summarizing the transcript, not this context.\n\n${options.agentContext}`
      : "") +
    (priorSummaryText
      ? `\n\nPrior recollection (already compacted earlier — fold its content into the new summary, do not discard it):\n${priorSummaryText}`
      : "")

  const summaryContext: Context = {
    systemPrompt: systemContent,
    messages: [{ role: "user", content: transcript, timestamp: Date.now() }],
  }

  try {
    const opts = apiKey ? { apiKey } : {}
    const resp = await complete(model, summaryContext, opts as unknown as import("@earendil-works/pi-ai").ProviderStreamOptions)
    const summaryText = resp.content
      .filter((p): p is TextContent => p.type === "text")
      .map((p) => p.text)
      .join("")
      .trim()
    if (!summaryText) return null
    if (summaryText.length < 80 || looksLikeMetaReply(summaryText)) {
      console.warn(`[context] llm summarization rejected (looks like meta-reply): ${summaryText.slice(0, 200)}`)
      return null
    }

    const replacedChars =
      (priorSummaryText ? priorSummaryText.length : 0) +
      middle.reduce((acc, m) => acc + messageStringContent(m).length, 0)
    if (summaryText.length > replacedChars * (1 - SUMMARY_MIN_REDUCTION)) {
      console.warn(`[context] llm summarization rejected: insufficient reduction (${summaryText.length} vs ${replacedChars} chars)`)
      return null
    }

    const summaryContent =
      `${CONTEXT_SUMMARY_HEADER}\n${CONTEXT_SUMMARY_NOTE}\n${CONTEXT_SUMMARY_SEGMENTS_MARKER}\n` +
      `[llm-summary ${new Date().toISOString()}]\n${summaryText}`

    return [
      ...head,
      { role: "user", content: summaryContent } as Message,
      ...tail,
    ]
  } catch (err) {
    console.warn(`[context] llm summarization failed: ${errorSummary(err)}`)
    return null
  }
}

/**
 * Estimates fallback context pressure and guardrails for current messages.
 *
 * @param messages - Current conversation history used for the next request.
 * @returns Token estimate plus soft/hard fallback limits.
 */
export function fallbackContextWindow(messages: Message[]): {
  estimate: number
  nearLimit: boolean
  skip: boolean
  softLimit: number
  hardLimit: number
} {
  const estimate = estimatePromptTokens(messages)

  if (!FALLBACK_ENFORCE_CONTEXT_LIMIT) {
    return {
      estimate,
      nearLimit: false,
      skip: false,
      softLimit: Number.POSITIVE_INFINITY,
      hardLimit: Number.POSITIVE_INFINITY,
    }
  }

  // softLimit: where we start warning. hardLimit: where we stop trying fallback at all.
  const softLimit = Math.max(0, FALLBACK_N_CTX - FALLBACK_CONTEXT_MARGIN)
  const hardLimit = FALLBACK_N_CTX + Math.max(0, FALLBACK_HARD_OVERFLOW_TOKENS)

  return {
    estimate,
    nearLimit: estimate >= softLimit,
    skip: estimate >= hardLimit,
    softLimit,
    hardLimit,
  }
}
