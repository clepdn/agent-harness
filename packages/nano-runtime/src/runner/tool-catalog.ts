import {
  createClientToolCatalog,
  createReadFileToolDefinition,
  type JsonSchema,
  type ToolDefinition,
} from "@nano/harness-core"
import type { ToolCapability, WorkspaceDescriptor } from "@nano/harness-protocol"

export type NiriToolCatalogOptions = {
  clientCapabilities?: Iterable<ToolCapability>
  workspace?: WorkspaceDescriptor | null
  memory?: boolean
  discord?: boolean
  subagents?: boolean
  computer?: boolean
  webSearch?: boolean
  /** Whether this runtime's active model can receive image inputs. */
  vision?: boolean
  /** Build the lower-trust virtual frontend lane (no executor or skills). */
  frontend?: boolean
  /** Expose the durable main/frontend mailbox. */
  agentChannel?: boolean
}

const functionTool = (name: string, description: string, parameters: JsonSchema): ToolDefinition => ({
  type: "function",
  function: { name, description, parameters },
})

const emptyParameters: JsonSchema = { type: "object", additionalProperties: false, properties: {} }

function imageToolDefinition(localPaths: boolean, imageRoot: string): ToolDefinition {
  return functionTool(
    "image_tool",
    localPaths
      ? `Attach an image from a public HTTP(S) URL or a bounded client file under ${imageRoot}.`
      : "Fetch an image from a public HTTP(S) URL and attach it for the next vision turn.",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: localPaths ? "Public HTTP(S) image URL or client image path." : "Public HTTP(S) image URL." },
        note: { type: "string", description: "Optional text instruction to accompany the image for the next turn." },
        detail: { type: "string", enum: ["auto", "low", "high"] },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
      },
      required: ["path"],
    },
  )
}

export const MEMORY_FS_TOOL_DEFINITION = functionTool(
  "memory_fs",
  "Manage files and directories in server-owned memory. Memory paths are relative to the memory root (memory:// is optional). op is create, delete, move, or copy. Move and copy require a memory-relative target. For copy, file_name may instead be local:// followed by an absolute or runtime-working-directory-relative container path. Copy accepts text or binary files, including images. Create makes an empty file, or a directory when file_name ends in '/'. Delete removes files or empty directories.",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      file_name: {
        type: "string",
        description: "Memory source/target path, or a local:// container path when copying into memory.",
      },
      op: { type: "string", enum: ["create", "delete", "move", "copy"] },
      target: { type: "string", description: "Memory-relative destination required for move and copy." },
    },
    required: ["file_name", "op"],
  },
)

export function createNiriToolCatalog(options: NiriToolCatalogOptions = {}): ToolDefinition[] {
  const clientCapabilities = new Set(options.clientCapabilities ?? [])
  // File reads and edits are server-owned for memory:// resources and therefore
  // always advertised. image_tool also has a server-owned URL path, so replace
  // the client-only definition with a combined one.
  const tools = createClientToolCatalog(options).filter(
    (tool) => !["read_file", "edit_file", "image_tool"].includes(tool.function.name),
  )
  if (options.vision ?? clientCapabilities.has("image_tool")) {
    tools.push(imageToolDefinition(
      clientCapabilities.has("image_tool") && !options.frontend,
      options.workspace?.imageRoot ?? options.workspace?.root ?? "the attached client workspace",
    ))
  }
  tools.push(
    createReadFileToolDefinition({
      hashline: options.workspace?.hashline === true,
      memory: true,
    }),
    MEMORY_FS_TOOL_DEFINITION,
    functionTool("job_list", "List background jobs and their current status.", emptyParameters),
    functionTool(
      "job_status",
      "Inspect one background job by id, including its captured stdout length and any terminal error.",
      {
        type: "object",
        additionalProperties: false,
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
      },
    ),
    functionTool(
      "job_stdout",
      "Read captured stdout from a background job using half-open character offsets [start, end). Omit start to read from the beginning or omit end to read through the currently available output. Reads are capped by max_chars and return nextStart when more output remains.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          job_id: { type: "string" },
          start: { type: "integer", minimum: 0 },
          end: { type: "integer", minimum: 0 },
          max_chars: { type: "integer", minimum: 1, maximum: 100000 },
        },
        required: ["job_id"],
      },
    ),
    functionTool(
      "job_cancel",
      "Cancel one running background job by id.",
      {
        type: "object",
        additionalProperties: false,
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
      },
    ),
    functionTool(
      "edit_file",
      "Edit a client file or server-owned memory by replacing exactly one old_text occurrence. For memory:// URIs, use the exact content and documentHash returned by memory_search; set new_text to an empty string to expunge a bad fact.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "A client path or memory:// Markdown URI." },
          old_text: { type: "string", minLength: 1, description: "Exact text to replace; it must occur once." },
          new_text: { type: "string", description: "Replacement text; may be empty to delete." },
          edits: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                op: { type: "string", enum: ["replace", "append", "prepend", "replace_text"] },
                pos: { type: "string" },
                end: { type: "string" },
                lines: { type: "array", items: { type: "string" } },
                oldText: { type: "string" },
                newText: { type: "string" },
              },
              required: ["op"],
            },
          },
          expected_hash: { type: "string", description: "Optional SHA-1 document hash for stale memory-source protection." },
          timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
        },
        required: ["path"],
      },
    ),
  )

  if (options.memory !== false) {
    tools.push(
      functionTool(
        "memory_search",
        "Search indexed long-term memory from authored notes and the Discord vector index. Discord results include an id accepted by memory_prune.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 10 },
          },
          required: ["query"],
        },
      ),
      functionTool(
        "memory_prune",
        "Permanently delete one locally stored Discord message and its vector-memory entry by the id returned from memory_search. A deletion marker prevents re-ingestion. Use ONLY when the user explicitly asks to remove that memory, or when memory_search has surfaced the entry and it is clearly wrong/bad or stale. Never use it merely because a result is irrelevant. Choose the reason truthfully.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", pattern: "^discord:[0-9]+$", description: "Exact Discord memory id returned by memory_search." },
            reason: {
              type: "string",
              enum: ["explicit_request", "surfaced_incorrect", "surfaced_stale"],
              description: "Why pruning is authorized: an explicit request, or a surfaced entry that is incorrect or stale.",
            },
            note: { type: "string", description: "Optional short explanation of what is wrong or stale." },
          },
          required: ["id", "reason"],
        },
      ),
      functionTool(
        "memory_alias",
        "List or update handle aliases used by memory recall.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["set", "remove", "list"] },
            handle: { type: "string" },
            canonical: { type: "string" },
          },
          required: ["action"],
        },
      ),
      functionTool(
        "memory_grep",
        "Search memories using exact substring matching, returning matching lines and numbers.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
            case_insensitive: { type: "boolean" },
          },
          required: ["query"],
        },
      ),
      functionTool(
        "skill",
        "Load a skill doc from memories/skills/ into context (frontmatter stripped). Skills are detailed how-to guides for specific capabilities. Check the Skills index in your system prompt for what's available, then load the relevant one before doing capability-specific work.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", description: "The skill name, e.g. 'flood' or 'tangled' (with or without the .md extension)." },
          },
          required: ["name"],
        },
      ),
      functionTool(
        "lcm_describe",
        "Inspect a known LCM summary by id before expanding it. Returns summary content, lineage, source counts, time ranges, estimated expansion cost, and a bounded-expansion manifest.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "The context summary id to inspect (sum_*)." },
            tokenCap: { type: "integer", minimum: 1, maximum: 1000000, description: "Optional token budget used to annotate which provenance nodes fit expansion." },
          },
          required: ["id"],
        },
      ),
      functionTool(
        "context_grep",
        "Search the immutable verbatim history of prior active-context messages. Use this when a compacted summary may have omitted a useful detail.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", description: "Literal case-insensitive text to find in original messages." },
            summary_id: { type: "string", description: "Optional context summary id to restrict the search to that summary's provenance tree." },
            limit: { type: "integer", minimum: 1, maximum: 30 },
          },
          required: ["query"],
        },
      ),
      functionTool(
        "context_expand",
        "Read a bounded page of verbatim messages beneath a context summary id. Results are paginated to keep the active context from flooding.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            summary_id: { type: "string" },
            offset: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 1, maximum: 40 },
          },
          required: ["summary_id"],
        },
      ),
    )
  }

  if (options.discord) {
    tools.push(
      functionTool(
        "discord_scan",
        "Scan configured Discord channels into the server-side inbox.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1 },
            channel_ids: { type: "array", items: { type: "string", description: "Discord channel id or a plant-object-object message id from that channel." } },
            before_message_id: { type: "string" },
          },
        },
      ),
      functionTool(
        "discord_inbox",
        "List pending Discord inbox items stored by this agent worker.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1 },
            status: { type: "string" },
          },
        },
      ),
      functionTool(
        "discord_backread",
        "Read stored Discord history for one channel, newest first.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            channel_id: { type: "string", description: "Discord channel id or a plant-object-object id shown on a message in that channel." },
            limit: { type: "integer", minimum: 1 },
            before_message_id: { type: "string" },
          },
          required: ["channel_id"],
        },
      ),
      functionTool(
        "discord_search",
        "Search stored Discord messages in one channel by text or message id.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            channel_id: { type: "string", description: "Discord channel id or a plant-object-object id shown on a message in that channel." },
            query: { type: "string" },
            message_id: { type: "string" },
            limit: { type: "integer", minimum: 1 },
          },
          required: ["channel_id"],
        },
      ),
      functionTool(
        "discord_send",
        "Send a Discord message. Omit target to answer the latest surfaced message. Use a shown rolling target number, plant-object-object id, or a prefix of its text to select a specific message. The 16 most recently surfaced messages remain targetable. A shown plant-object-object id is also valid as channel_id and reference_message.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            channel_id: { type: "string", description: "Discord channel id or a plant-object-object id shown on a message in that channel." },
            content: { type: "string" },
            target: { oneOf: [{ type: "integer", minimum: 1 }, { type: "string", minLength: 1 }], description: "Shown target number, plant-object-object id, or message-text prefix." },
            reply_mode: { type: "string", enum: ["auto", "plain", "explicit"], description: "Auto and explicit share the same reference eligibility checks; plain never creates a reply reference." },
            reference_message: { type: "string", description: "Discord message id, plant-object-object id shown on a message, message-text prefix, or author name. A plant-object-object id supplies its channel automatically, so channel_id may be omitted." },
          },
          required: ["content"],
        },
      ),
      functionTool("discord_channels", "List configured Discord channels and notes.", emptyParameters),
      functionTool(
        "discord_channel_note",
        "Set or clear the note for a Discord channel.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            channel_id: { type: "string", description: "Discord channel id or a plant-object-object id shown on a message in that channel." },
            note: { type: "string" },
          },
          required: ["channel_id", "note"],
        },
      ),
      functionTool(
        "discord_mark",
        "Set decision state for a Discord inbox item.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            item_id: { type: "string" },
            status: { type: "string", enum: ["pending", "seen", "acted", "ignored"] },
            action: { type: "string", enum: ["none", "replied", "messaged", "dismissed", "noted"] },
            note: { type: "string" },
          },
          required: ["item_id", "status"],
        },
      ),
      functionTool(
        "discord_upload",
        "Upload a file to a Discord channel. A shown plant-object-object id is valid as channel_id and reference_message.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            channel_id: { type: "string", description: "Discord channel id or a plant-object-object id shown on a message in that channel." },
            file_path: { type: "string" },
            content: { type: "string" },
            target: { oneOf: [{ type: "integer", minimum: 1 }, { type: "string", minLength: 1 }], description: "Shown target number, plant-object-object id, or message-text prefix." },
            reply_mode: { type: "string", enum: ["auto", "plain", "explicit"], description: "Auto and explicit share the same reference eligibility checks; plain never creates a reply reference." },
            reference_message: { type: "string", description: "Discord message id, plant-object-object id shown on a message, message-text prefix, or author name. A plant-object-object id supplies its channel automatically, so channel_id may be omitted." },
          },
          required: ["file_path"],
        },
      ),
      functionTool(
        "set_status",
        "Set or clear this agent's Discord custom status text.",
        {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string" } },
        },
      ),
    )
  }

  if (options.webSearch) {
    tools.push(
      functionTool(
        "web_search",
        "Search the live web via Exa. Returns titles, URLs, and snippets. Use this to look up current information, verify facts, or research a topic you don't have in memory.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", description: "The search query." },
            num_results: { type: "integer", minimum: 1, maximum: 25, description: "How many results to return (default 5)." },
            include_text: { type: "boolean", description: "When true, pull short page-content highlights for each result, not just snippets. Default false." },
          },
          required: ["query"],
        },
      ),
    )
  }

  if (options.subagents) {
    tools.push(
      functionTool(
        "subagent",
        "Spawn a configured subagent to handle one task.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            task: { type: "string" },
            blocking: { type: "boolean" },
          },
          required: ["name", "task"],
        },
      ),
    )
  }

  if (options.computer) {
    tools.push(
      functionTool(
        "computer",
        "Interact with the configured graphical desktop.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["screenshot", "click", "double_click", "scroll", "type", "keypress", "drag", "move", "wait"] },
            x: { type: "integer" },
            y: { type: "integer" },
            button: { type: "string", enum: ["left", "right", "middle"] },
            text: { type: "string" },
            keys: { type: "array", items: { type: "string" } },
            scroll_x: { type: "integer" },
            scroll_y: { type: "integer" },
            path: { type: "array", items: { type: "array", items: { type: "integer" } } },
            duration: { type: "integer" },
          },
          required: ["action"],
        },
      ),
    )
  }

  if (options.agentChannel) {
    tools.push(
      functionTool(
        "agent_send",
        "Send a durable message to the other virtual agent. The recipient is main when called by frontend, and frontend when called by main. The message wakes the recipient.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            content: { type: "string", minLength: 1 },
          },
          required: ["content"],
        },
      ),
      functionTool(
        "agent_channel",
        "Read recent durable messages exchanged between the main and frontend virtual agents.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100 },
            before_id: { type: "string" },
          },
        },
      ),
    )
  }

  tools.push(
    functionTool(
      "voice_reply",
      "Reply to a pending realtime voice delegation. Use only the exact delegation_id from a voice delegation event and provide explicit text intended to be spoken; never send private reasoning.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          delegation_id: { type: "string" },
          input_text: { type: "string" },
        },
        required: ["delegation_id", "input_text"],
      },
    ),
    functionTool("wait", "Wait for the next incoming message or event.", emptyParameters),
    functionTool(
      "wait_then_continue",
      "Wait for a bounded delay or an incoming event, then continue.",
      {
        type: "object",
        additionalProperties: false,
        properties: { timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 } },
      },
    ),
    functionTool(
      "end_session",
      "End the active session after writing a durable snapshot.",
      {
        type: "object",
        additionalProperties: false,
        properties: { note: { type: "string" } },
      },
    ),
  )

  if (!options.frontend) return tools

  // The frontend is normal nano at the server boundary, but it cannot reach
  // the attached executor, inspect executor jobs, load skills, or upload a
  // client-side path through Discord.
  const unavailable = new Set([
    "shell",
    "job_list",
    "job_status",
    "job_stdout",
    "job_cancel",
    "computer",
    "subagent",
    "skill",
    "discord_upload",
  ])
  return tools
    .filter((tool) => !unavailable.has(tool.function.name))
    .map((tool) => {
      if (tool.function.name === "read_file") {
        const definition = createReadFileToolDefinition({ memory: true })
        return {
          ...definition,
          function: {
            ...definition.function,
            description: "Read a server-owned memory:// file or directory. Ordinary and attached-client paths are unavailable; memories/skills is also unavailable.",
          },
        }
      }
      if (tool.function.name === "edit_file") {
        return functionTool(
          "edit_file",
          "Edit a server-owned memory:// Markdown resource by replacing exactly one old_text occurrence. Local and attached-client paths are unavailable.",
          tool.function.parameters,
        )
      }
      return tool
    })
}

/** Replace only image_tool in a restored pinned catalog when URL support or vision availability changed. */
export function reconcileImageToolDefinition(
  saved: readonly ToolDefinition[],
  current: readonly ToolDefinition[],
): { catalog: ToolDefinition[]; changed: boolean } {
  const desired = current.find((tool) => tool.function.name === "image_tool")
  const existing = saved.find((tool) => tool.function.name === "image_tool")
  if (JSON.stringify(existing) === JSON.stringify(desired)) return { catalog: [...saved], changed: false }
  const catalog = saved.filter((tool) => tool.function.name !== "image_tool")
  if (desired) {
    const readIndex = catalog.findIndex((tool) => tool.function.name === "read_file")
    catalog.splice(readIndex < 0 ? catalog.length : readIndex, 0, desired)
  }
  return { catalog, changed: true }
}
