import type { Tool, TSchema } from "../llm"
import { createReadFileToolDefinition, type ToolDefinition } from "@nano/harness-core"
import { config } from "../config"
import { imageRootForModelInput } from "../container/index"
import { clientTools } from "../client"
import { MEMORY_FS_TOOL_DEFINITION } from "./tool-catalog"

// Placeholder: the real root belongs to whichever client is attached, which
// can change mid-session via the /client/connect handshake.
const IMAGE_ROOT_HINT = "{{IMAGE_ROOT}}"
const READ_FILE_TOOL = createReadFileToolDefinition({ memory: true }).function

/** Cast a plain JSON Schema object to the TSchema type. */
function s(schema: Record<string, unknown>): TSchema {
  return schema as unknown as TSchema
}

export const TOOLS: Tool[] = [
  {
    name: "shell",
    description:
      "Execute a bash command in a fresh process in your Linux environment. Every call starts at the workspace root; cd and environment changes do not persist. Set pty=true only for commands that require terminal semantics. Output is automatically capped (default 150 lines, 40 for known-verbose commands like apt/pip/npm). Pass max_lines to override; use 0 for unlimited. You can also pass timeout_ms (default 30000, max 600000). Commands still running after 120 seconds detach into a background job and return a job id.",
    parameters: s({
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
        pty: {
          type: "boolean",
          description: "Allocate a fresh PTY for this command. Defaults to false.",
        },
      },
      required: ["command"],
    }),
  },
  {
    name: "job_list",
    description: "List background jobs and their current status, ids, and elapsed times.",
    parameters: s({ type: "object", additionalProperties: false, properties: {} }),
  },
  {
    name: "job_status",
    description: "Inspect one background job by id, including its captured stdout length and any terminal error.",
    parameters: s({
      type: "object",
      additionalProperties: false,
      properties: { job_id: { type: "string", description: "Exact job id returned by shell or subagent." } },
      required: ["job_id"],
    }),
  },
  {
    name: "job_stdout",
    description:
      "Read captured stdout from a background job using half-open character offsets [start, end). Omit start to read from the beginning or omit end to read through the currently available output. Reads are capped by max_chars and return nextStart when more output remains.",
    parameters: s({
      type: "object",
      additionalProperties: false,
      properties: {
        job_id: { type: "string", description: "Exact job id returned by shell or subagent." },
        start: { type: "integer", minimum: 0, description: "Inclusive character offset. Defaults to 0." },
        end: { type: "integer", minimum: 0, description: "Exclusive character offset. Defaults to the current stdout length." },
        max_chars: { type: "integer", minimum: 1, maximum: 100000, description: "Maximum characters returned. Defaults to 20000." },
      },
      required: ["job_id"],
    }),
  },
  {
    name: "job_cancel",
    description: "Cancel one running background job by id. Use only when that work should no longer continue.",
    parameters: s({
      type: "object",
      additionalProperties: false,
      properties: { job_id: { type: "string", description: "Exact id of the running job to cancel." } },
      required: ["job_id"],
    }),
  },
  {
    name: READ_FILE_TOOL.name,
    description: READ_FILE_TOOL.description,
    parameters: s(READ_FILE_TOOL.parameters),
  },
  {
    name: MEMORY_FS_TOOL_DEFINITION.function.name,
    description: MEMORY_FS_TOOL_DEFINITION.function.description,
    parameters: s(MEMORY_FS_TOOL_DEFINITION.function.parameters),
  },
  {
    name: "edit_file",
    description:
      "Edit a file by replacing an exact snippet of text. old_text must match exactly once in the file — precise, safe, and no shell-escaping headaches. Use read_file first if you need to confirm the exact text. Supports timeout_ms (default 120000, max 600000).",
    parameters: s({
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file." },
        old_text: { type: "string", description: "The exact text to find and replace. Must appear exactly once in the file." },
        new_text: { type: "string", description: "Replacement text. May be empty to delete old_text." },
        timeout_ms: { type: "integer", description: "Edit timeout in milliseconds. Defaults to 120000. Max 600000." },
      },
      required: ["path", "old_text", "new_text"],
    }),
  },
  {
    name: "memory_search",
    description:
      "Search indexed long-term memories from authored notes and the Discord vector index. Discord results include an id accepted by memory_prune.",
    parameters: s({
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for in long-term memory." },
        limit: { type: "integer", description: "Maximum results to return (default 5, max 10)." },
      },
      required: ["query"],
    }),
  },
  {
    name: "memory_prune",
    description:
      "Permanently delete one locally stored Discord message and its vector-memory entry by the id returned from memory_search. A deletion marker prevents re-ingestion. Use ONLY when the user explicitly asks to remove that memory, or when memory_search has surfaced the entry and it is clearly wrong/bad or stale. Never use it merely because a result is irrelevant. Choose the reason truthfully.",
    parameters: s({
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", pattern: "^discord:[0-9]+$", description: "Exact Discord memory id returned by memory_search." },
        reason: {
          type: "string",
          enum: ["explicit_request", "surfaced_incorrect", "surfaced_stale"],
        },
        note: { type: "string", description: "Optional short explanation of what is wrong or stale." },
      },
      required: ["id", "reason"],
    }),
  },
  {
    name: "memory_alias",
    description:
      "Manage handle aliases used for memory recall. When you see someone using a Discord/Bluesky handle that you recognize as an existing person in memory, set an alias so future messages from that handle pull the right people/core memories. Example: set @meowskullz = ana so DMs from meowskullz recall ana's people file.",
    parameters: s({
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
    }),
  },
  {
    name: "image_tool",
    description: `Attach an image from a public HTTP(S) URL or a client file (e.g. ${IMAGE_ROOT_HINT}/screenshot.png) so it is injected as a multimodal user message on the next model turn.`,
    parameters: s({
      type: "object",
      properties: {
        path: { type: "string", description: "Public HTTP(S) image URL or absolute client path to an image file." },
        note: { type: "string", description: "Optional text instruction to accompany the image for the next turn." },
        timeout_ms: { type: "integer", description: "Read timeout in milliseconds. Defaults to 120000. Max 600000." },
      },
      required: ["path"],
    }),
  },
  {
    name: "discord_scan",
    description:
      "Scan configured Discord channels and ingest messages into the local Discord inbox database. Uses the [discord].scan_channel_ids config by default; pass channel_ids to override.",
    parameters: s({
      type: "object",
      properties: {
        limit: { type: "integer", description: "Per-channel message fetch limit (default 50, max 100)." },
        channel_ids: { type: "array", items: { type: "string" }, description: "Optional channel id list to scan instead of [discord].scan_channel_ids. Each value may be a Discord channel id or a plant-object-object id shown on a message in that channel." },
        before_message_id: { type: "string", description: "Optional message id cursor for older backfill scans." },
      },
    }),
  },
  {
    name: "discord_inbox",
    description: "List Discord inbox items tracked in local state. Default status filter is pending; optionally include seen/acted/ignored.",
    parameters: s({
      type: "object",
      properties: {
        limit: { type: "integer", description: "Maximum rows to return (default 20, max 200)." },
        status: { type: "string", description: "Comma-separated statuses: pending,seen,acted,ignored. Defaults to pending." },
      },
    }),
  },
  {
    name: "discord_backread",
    description: "Read stored Discord message history for a channel from local state, newest first.",
    parameters: s({
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Discord channel id or a plant-object-object id shown on a message in that channel." },
        limit: { type: "integer", description: "Maximum rows to return (default 40, max 200)." },
        before_message_id: { type: "string", description: "Optional cursor message id to fetch older rows." },
      },
      required: ["channel_id"],
    }),
  },
  {
    name: "discord_mark",
    description: "Set decision state for a Discord inbox item so future scans remember handled/ignored choices.",
    parameters: s({
      type: "object",
      properties: {
        item_id: { type: "string", description: "Inbox item id (usually message id)." },
        status: { type: "string", enum: ["pending", "seen", "acted", "ignored"] },
        action: { type: "string", enum: ["none", "replied", "messaged", "dismissed", "noted"] },
        note: { type: "string", description: "Optional decision note." },
      },
      required: ["item_id", "status"],
    }),
  },
  {
    name: "discord_send",
    description:
      "Send a Discord message. Omit target to answer the latest surfaced message; use a shown rolling target number, plant-object-object id, or a prefix of its text to select a specific message. The 16 most recently surfaced messages remain targetable. A shown plant-object-object id is also valid as channel_id and reference_message.",
    parameters: s({
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Target Discord channel id or a plant-object-object id shown on a message in that channel." },
        content: { type: "string", description: "Message content to send." },
        target: { oneOf: [{ type: "integer", minimum: 1 }, { type: "string", minLength: 1 }], description: "Shown target number, plant-object-object id, or message-text prefix." },
        reply_mode: { type: "string", enum: ["auto", "plain", "explicit"], description: "Reply behavior policy (default auto). Auto and explicit share the same reference eligibility checks; plain never creates a reply reference." },
        reference_message: { type: "string", description: "Optional message reference: a Discord message id, a plant-object-object id shown on a message, a message-text prefix, or an author name. A plant-object-object id supplies its channel automatically, so channel_id may be omitted." },
      },
      required: ["content"],
    }),
  },
  {
    name: "discord_upload",
    description:
      "Upload a file to a Discord channel, optionally with a text caption. A shown plant-object-object id is valid as channel_id and reference_message. Reads the file from your local filesystem. Max 25 MB.",
    parameters: s({
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Target Discord channel id or a plant-object-object id shown on a message in that channel." },
        file_path: { type: "string", description: "Absolute or relative path to the file on your filesystem." },
        content: { type: "string", description: "Optional text caption to send with the file." },
        target: { oneOf: [{ type: "integer", minimum: 1 }, { type: "string", minLength: 1 }], description: "Shown target number, plant-object-object id, or message-text prefix." },
        reply_mode: { type: "string", enum: ["auto", "plain", "explicit"], description: "Reply behavior policy (default auto). Auto and explicit share the same reference eligibility checks; plain never creates a reply reference." },
        reference_message: { type: "string", description: "Optional message reference: a Discord message id, a plant-object-object id shown on a message, a message-text prefix, or an author name. A plant-object-object id supplies its channel automatically, so channel_id may be omitted." },
      },
      required: ["file_path"],
    }),
  },
  {
    name: "discord_channels",
    description: "List configured Discord channels and DM channels with stored interactions, including id-to-name mapping, guild context, and optional channel notes.",
    parameters: s({ type: "object", properties: {} }),
  },
  {
    name: "discord_channel_note",
    description: "Set or clear a persistent note for a Discord channel id. Pass empty note to clear.",
    parameters: s({
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Discord channel id to annotate, or a plant-object-object id shown on a message in that channel." },
        note: { type: "string", description: "Channel-specific note text. Empty string clears it." },
      },
      required: ["channel_id", "note"],
    }),
  },
  {
    name: "set_status",
    description:
      "Set your own Discord custom status text. The status appears as a custom activity. Auto-generated info (context usage % and API request count) is always appended. Format: \"{your text} | {auto_info}\". Pass empty string or null to clear. Max 128 chars total — keep your text short.",
    parameters: s({
      type: "object",
      properties: {
        text: { type: "string", description: "Custom status text. Empty string or null clears the custom portion." },
      },
    }),
  },
  {
    name: "wait",
    description: "Pause and wait for the next incoming message or event. Use this when you've finished what you're doing and want to hear back before continuing.",
    parameters: s({ type: "object", properties: {} }),
  },
  {
    name: "wait_then_continue",
    description:
      "Wait for a short delay, then continue to another assistant turn without waiting for a new external event. Use this after a timeout or recoverable tool error when you still want to keep working. Accepts timeout_ms (default 10000, max 600000).",
    parameters: s({
      type: "object",
      properties: {
        timeout_ms: { type: "integer", description: "Delay before continuing in milliseconds. Defaults to 10000. Max 600000." },
      },
    }),
  },
  {
    name: "end_session",
    description: "End the active session. Call this when you're truly done for now — conversation context will be cleared.",
    parameters: s({
      type: "object",
      properties: {
        note: { type: "string", description: "Optional note to yourself about where you left off." },
      },
    }),
  },
  {
    name: "subagent",
    description:
      "Spawn a named subagent to handle a task. Subagents run with their own conversation state, system prompt, and tool set (configured in TOML). They cannot wait for events or interact with Discord directly. By default runs as a background job — you'll be woken and notified when it completes. Set blocking=true to wait for the result inline (returns the subagent's final text output directly).",
    parameters: s({
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the configured subagent to spawn." },
        task: { type: "string", description: "The task description to give the subagent." },
        blocking: { type: "boolean", description: "If true, block and wait for the subagent to finish (returns result directly). If false (default), spawn as a background job and get notified on completion." },
      },
      required: ["name", "task"],
    }),
  },
  {
    name: "computer",
    description:
      "Computer use tool — interact with a graphical desktop via xdotool and ImageMagick. Takes a single action. Actions: screenshot (capture screen as image), click (left/right/middle at x,y), double_click, scroll (at x,y with scroll_y amount), type (text string), keypress (array of key names like CTRL+c), drag (path of [x,y] points), move (mouse to x,y), wait (duration ms). Requires [computer_use] enabled = true and a running X display.",
    parameters: s({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["screenshot", "click", "double_click", "scroll", "type", "keypress", "drag", "move", "wait"],
          description: "The computer use action to perform.",
        },
        x: { type: "integer", description: "X coordinate (for click, double_click, scroll, move)." },
        y: { type: "integer", description: "Y coordinate (for click, double_click, scroll, move)." },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button (default: left)." },
        text: { type: "string", description: "Text to type (for type action)." },
        keys: {
          type: "array",
          items: { type: "string" },
          description: "Key combination to press (for keypress action). e.g. [\"CTRL\", \"c\"], [\"ENTER\"], [\"SHIFT\", \"ARROWLEFT\"].",
        },
        scroll_x: { type: "integer", description: "Horizontal scroll amount (for scroll action)." },
        scroll_y: { type: "integer", description: "Vertical scroll amount (for scroll action). Positive = down, negative = up." },
        path: {
          type: "array",
          items: { type: "array", items: { type: "integer" } },
          description: "Drag path as array of [x, y] points (for drag action). First point is start, last is end.",
        },
        duration: { type: "integer", description: "Wait duration in milliseconds (for wait action, default 1000)." },
      },
      required: ["action"],
    }),
  },
]

import { modelStateFor } from "./model-state"
import type { RuntimeKind } from "./types"

// ── Tool filtering ────────────────────────────────────────────────────────────

/** All tool names in declaration order. */
export const ALL_TOOL_NAMES = TOOLS.map((t) => t.name)

/**
 * Returns true if a tool is enabled for the main agent based on [tools] config.
 * - If enabled_tools is empty, all tools are enabled.
 * - blacklisted_tools always removes a tool regardless.
 */
export function isToolEnabled(name: string, runtimeKind: RuntimeKind = "main"): boolean {
  const { enabled_tools, blacklisted_tools } = config.tools
  if (name === "image_tool" && !modelStateFor(runtimeKind).primaryVision) return false
  if (name === "computer" && !config.computer_use.enabled) return false
  const enabled = enabled_tools.length === 0 || enabled_tools.includes(name)
  return enabled && !blacklisted_tools.includes(name)
}

/** Resolve {{IMAGE_ROOT}} against the attached client's workspace. */
function withImageRoot(tool: Tool): Tool {
  if (!tool.description.includes(IMAGE_ROOT_HINT)) return tool
  const root = clientTools.getWorkspace()?.imageRoot || imageRootForModelInput()
  return { ...tool, description: tool.description.replaceAll(IMAGE_ROOT_HINT, root) }
}

/** Filtered tool list for the main agent (after [tools] config). */
function getActiveTools(runtimeKind: RuntimeKind = "main"): Tool[] {
  return TOOLS.filter((t) => isToolEnabled(t.name, runtimeKind)).map(withImageRoot)
}

/**
 * Returns true if a tool is available to a subagent.
 * Auto-blacklists event-loop tools (wait, rest, wait_then_continue, subagent).
 */
const SUBAGENT_AUTO_BLACKLIST = new Set([
  "wait",
  "end_session",
  "wait_then_continue",
  "subagent",
  "job_list",
  "job_status",
  "job_stdout",
  "job_cancel",
])

export function isToolEnabledForSubagent(
  name: string,
  enabledTools: string[],
  blacklistedTools: string[],
): boolean {
  if (SUBAGENT_AUTO_BLACKLIST.has(name)) return false
  const enabled = enabledTools.length === 0 || enabledTools.includes(name)
  return enabled && !blacklistedTools.includes(name)
}

/** Filtered tool list for a subagent. */
export function getSubagentTools(enabledTools: string[], blacklistedTools: string[]): Tool[] {
  return TOOLS.filter((t) => isToolEnabledForSubagent(t.name, enabledTools, blacklistedTools)).map(withImageRoot)
}

// ── Completion tool catalog ─────────────────────────────────────────────────
const DYNAMICALLY_GATED_TOOLS = new Set([
  "shell",
  "read_file",
  "edit_file",
  "image_tool",
  "computer",
  "discord_scan",
  "discord_inbox",
  "discord_backread",
  "discord_mark",
  "discord_send",
  "discord_upload",
  "discord_channels",
  "discord_channel_note",
  "set_status",
])

export function getCompletionTools(toolDefinitions?: ToolDefinition[], runtimeKind: RuntimeKind = "main"): Tool[] {
  if (!toolDefinitions) return getActiveTools(runtimeKind)

  const tools = toolDefinitions.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters as TSchema,
  }))
  const names = new Set(tools.map((tool) => tool.name))
  for (const tool of getActiveTools(runtimeKind)) {
    if (!names.has(tool.name) && !DYNAMICALLY_GATED_TOOLS.has(tool.name)) tools.push(tool)
  }
  return tools.filter((tool) => isToolEnabled(tool.name, runtimeKind))
}
