import type { UserMessage as PiUserMessage } from "../llm"
import { config } from "../config"
import { normalizeTimeoutMs } from "../container/config"
import type { ClientImageArtifact, ClientToolName } from "@mira/harness-protocol"
import { AGENT_ID } from "../agent-config"
import { clientTools } from "../client"
import { logMessage } from "../db"
import {
  listDiscordBackread,
  listDiscordChannels,
  listDiscordInbox,
  markDiscordItem,
  scanDiscordChannels,
  sendDiscordMessage,
  setDiscordChannelNote,
  uploadDiscordFile,
} from "../discord/state"
import { listAliases, removeAlias, searchMemories, setAlias } from "../memory"
import { setCustomStatus } from "../discord/status-updater"
import { emit } from "../stream"
import type { ToolHandler } from "./loop-shared"
import { checkGitUpstream } from "./git-upstream-check"
import { GIT_UPSTREAM_NAG } from "./config"
import { pushToolMessage, recordToolResult, runStandardTool, toolError } from "./loop-tool-runtime"
import { findSubagent, runSubagent } from "./subagent"
import { startJob } from "./jobs"
import { saveRestSnapshot } from "./util"
import { executeAction } from "./computer-use"

const DEFAULT_WAIT_THEN_CONTINUE_MS = 10_000

/**
 * Invoke a tool on the attached client. Undefined args are dropped so the
 * client sees only what the model actually supplied.
 */
async function runClientTool(tool: ClientToolName, args: Record<string, unknown>): Promise<string> {
  const supplied: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) supplied[key] = value
  }
  const result = await clientTools.execute({
    agentId: AGENT_ID,
    tool,
    args: supplied,
    ...(typeof args.timeout_ms === "number" ? { timeoutMs: args.timeout_ms } : {}),
  })
  if (result.status === "ok") return result.output ?? ""
  return result.output?.startsWith("error:") ? result.output : `error: ${result.output ?? `${tool} failed`}`
}

/**
 * Fetch an image artifact from the attached client. Throws so the caller's
 * existing catch records the failure as a tool error.
 */
async function runClientImageTool(path: string, timeoutMs?: number): Promise<ClientImageArtifact> {
  const result = await clientTools.execute({
    agentId: AGENT_ID,
    tool: "image_tool",
    args: { path },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  })
  if (result.status !== "ok" || !result.image) throw new Error(result.output ?? "image_tool returned no image")
  return result.image
}

/**
 * Builds the function-tool handler table for the runner loop.
 */
export function buildToolHandlers(): Record<string, ToolHandler> {
  return {
    wait_then_continue: async ({ convId, state, hooks, call, args }) => {
      const timeoutMs = normalizeTimeoutMs(args.timeout_ms as number | undefined, DEFAULT_WAIT_THEN_CONTINUE_MS)
      recordToolResult(
        convId,
        state,
        call,
        "wait_then_continue",
        args,
        `Waiting up to ${timeoutMs}ms for an event or timeout, then continuing.`,
      )
      console.log(`[runner] wait_then_continue: waiting up to ${timeoutMs}ms...`)
      const event = await hooks.waitForEventWithTimeout(timeoutMs)
      if (event) {
        console.log(`[runner] wait_then_continue: interrupted early by incoming ${event.source} event`)
        hooks.injectIncomingEvent(convId, event)
        return { isWait: true }
      }
      console.log(`[runner] wait_then_continue: timeout elapsed, continuing to next turn`)
      return {}
    },

    wait: async ({ convId, state, hooks, call, args }) => {
      recordToolResult(convId, state, call, "wait", args, "Waiting for next event.")
      console.log("[runner] niri is waiting for next event...")
      const incoming = await hooks.waitForEvent(); if (!incoming) return {}
      hooks.injectIncomingEvent(convId, incoming)
      return { isWait: true }
    },

    end_session: async ({ convId, state, call, args }) => {
      if (args.note) console.log("[runner] end_session note:", args.note)
      recordToolResult(convId, state, call, "end_session", args, "Session ended.")
      await saveRestSnapshot(state.conversation, args.note as string | undefined)
      return { shouldRest: true }
    },

    shell: (ctx) =>
      runStandardTool(ctx, {
        name: "shell",
        logArgKeys: ["command", "timeout_ms"] as const,
        runArgKeys: ["command", "max_lines", "timeout_ms"] as const,
        run: (command, max_lines, timeout_ms) => runClientTool("shell", { command, max_lines, timeout_ms }),
        emptyFallback: "(no output)",
      }),

    read_file: async (ctx) => {
      const result = await runStandardTool(ctx, {
        name: "read_file",
        logArgKeys: ["path", "start_line", "end_line", "timeout_ms"] as const,
        runArgKeys: ["path", "start_line", "end_line", "timeout_ms"] as const,
        run: (path, start_line, end_line, timeout_ms) =>
          runClientTool("read_file", { path, start_line, end_line, timeout_ms }),
        emptyFallback: "(empty file)",
      })
      if (GIT_UPSTREAM_NAG) {
        checkGitUpstream(ctx.args.path as string, ctx.convId, ctx.state)
      }
      return result
    },

    // Anchored (`edits`) and exact-text (`old_text`/`new_text`) payloads are both
    // forwarded as-is; the attached client decides which contract it serves.
    edit_file: async (ctx) => {
      const result = await runStandardTool(ctx, {
        name: "edit_file",
        logArgKeys: ["path", "timeout_ms"] as const,
        runArgKeys: ["path", "edits", "old_text", "new_text", "timeout_ms"] as const,
        run: (path, edits, old_text, new_text, timeout_ms) =>
          runClientTool("edit_file", { path, edits, old_text, new_text, timeout_ms }),
        emitArgKeys: ["path"] as const,
        previewChars: 0,
      })
      if (GIT_UPSTREAM_NAG) {
        checkGitUpstream(ctx.args.path as string, ctx.convId, ctx.state)
      }
      return result
    },

    memory_search: (ctx) =>
      runStandardTool(ctx, {
        name: "memory_search",
        logArgKeys: ["query", "limit"] as const,
        runArgKeys: ["query", "limit"] as const,
        run: async (query, limit) =>
          JSON.stringify(
            {
              query,
              results: await searchMemories(query as string, limit as number | undefined),
            },
            null,
            2,
          ),
        emptyFallback: '{"query":"","results":[]}',
      }),

    memory_alias: (ctx) =>
      runStandardTool(ctx, {
        name: "memory_alias",
        logArgKeys: ["action", "handle", "canonical"] as const,
        runArgKeys: ["action", "handle", "canonical"] as const,
        run: async (action, handle, canonical) => {
          const op = String(action ?? "").toLowerCase()
          if (op === "list") {
            return JSON.stringify({ ok: true, aliases: await listAliases() }, null, 2)
          }
          if (op === "set") {
            if (!handle || !canonical) {
              return JSON.stringify({ ok: false, error: "set requires handle and canonical" })
            }
            const map = await setAlias(String(handle), String(canonical))
            return JSON.stringify({ ok: true, aliases: map }, null, 2)
          }
          if (op === "remove") {
            if (!handle) return JSON.stringify({ ok: false, error: "remove requires handle" })
            const map = await removeAlias(String(handle), canonical ? String(canonical) : undefined)
            return JSON.stringify({ ok: true, aliases: map }, null, 2)
          }
          return JSON.stringify({ ok: false, error: `unknown action: ${op}` })
        },
      }),

    image_tool: async ({ convId, state, call, args }) => {
      console.log("[image_tool]", args.path, args.timeout_ms)
      let result: string

      try {
        const image = await runClientImageTool(args.path as string, args.timeout_ms as number | undefined)
        const note =
          typeof args.note === "string" && args.note.trim()
            ? args.note.trim()
            : `Please inspect this image: ${image.path}`

        result = pushToolMessage(convId, state, call, `attached ${image.path} (${image.mime}, ${image.bytes} bytes)`)

        // Extract base64 data and MIME type from data URL
        const commaIdx = image.dataUrl.indexOf(",")
        const mimeMatch = image.dataUrl.match(/data:([^;]+)/)
        const mimeType = mimeMatch?.[1] ?? image.mime
        const data = commaIdx >= 0 ? image.dataUrl.slice(commaIdx + 1) : image.dataUrl

        const imageMessage: PiUserMessage = {
          role: "user",
          content: [
            { type: "text", text: note },
            { type: "image", data, mimeType },
          ],
          timestamp: Date.now(),
        }
        state.conversation.push(imageMessage)
        logMessage(convId, "user", `[image_tool] ${note}\npath=${image.path}`)
      } catch (err) {
        result = recordToolResult(convId, state, call, "image_tool", { path: args.path }, toolError(err))
        return {}
      }

      emit({ type: "tool", name: "image_tool", args: { path: args.path }, result })
      return {}
    },

    discord_scan: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_scan",
        logArgKeys: ["limit", "before_message_id"] as const,
        runArgKeys: ["limit", "channel_ids", "before_message_id"] as const,
        run: async (limit, channel_ids, before_message_id) =>
          JSON.stringify(
            await scanDiscordChannels({
              limit: limit as number | undefined,
              channelIds: channel_ids as string[] | string | undefined,
              beforeMessageId: before_message_id as string | undefined,
            }),
            null,
            2,
          ),
      }),

    discord_inbox: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_inbox",
        logArgKeys: ["limit", "status"] as const,
        runArgKeys: ["limit", "status"] as const,
        run: async (limit, status) =>
          JSON.stringify(
            listDiscordInbox(limit as number | undefined, status as string | string[] | undefined),
            null,
            2,
          ),
      }),

    discord_backread: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_backread",
        logArgKeys: ["channel_id", "limit", "before_message_id"] as const,
        runArgKeys: ["channel_id", "limit", "before_message_id"] as const,
        run: async (channel_id, limit, before_message_id) =>
          JSON.stringify(
            listDiscordBackread(
              channel_id as string,
              limit as number | undefined,
              before_message_id as string | undefined,
            ),
            null,
            2,
          ),
      }),

    discord_mark: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_mark",
        logArgKeys: ["item_id", "status", "action"] as const,
        runArgKeys: ["item_id", "status", "note", "action"] as const,
        run: async (item_id, status, note, action) => {
          markDiscordItem(
            item_id as string,
            status as "pending" | "seen" | "acted" | "ignored",
            (note as string | undefined) ?? "",
            (action as "none" | "replied" | "messaged" | "dismissed" | "noted" | undefined) ?? "none",
          )
          return JSON.stringify(
            {
              ok: true,
              item_id,
              status,
              action: action ?? "none",
              note: note ?? "",
            },
            null,
            2,
          )
        },
      }),

    discord_send: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_send",
        logArgKeys: ["channel_id", "source_item_id", "reply_mode"] as const,
        runArgKeys: ["channel_id", "content", "source_item_id", "reply_mode", "reference_message"] as const,
        run: async (channel_id, content, source_item_id, reply_mode, reference_message) =>
          JSON.stringify(
            await sendDiscordMessage({
              channelId: channel_id as string,
              content: content as string,
              sourceItemId: source_item_id as string | undefined,
              replyMode: reply_mode as string | undefined,
              referenceMessage: reference_message as string | undefined,
            }),
            null,
            2,
          ),
      }),

    discord_upload: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_upload",
        logArgKeys: ["channel_id", "file_path", "source_item_id", "reply_mode"] as const,
        runArgKeys: ["channel_id", "file_path", "content", "source_item_id", "reply_mode", "reference_message"] as const,
        run: async (channel_id, file_path, content, source_item_id, reply_mode, reference_message) =>
          JSON.stringify(
            await uploadDiscordFile({
              channelId: channel_id as string,
              filePath: file_path as string,
              content: content as string | undefined,
              sourceItemId: source_item_id as string | undefined,
              replyMode: reply_mode as string | undefined,
              referenceMessage: reference_message as string | undefined,
            }),
            null,
            2,
          ),
      }),

    discord_channels: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_channels",
        logArgKeys: [] as const,
        runArgKeys: [] as const,
        run: async () => JSON.stringify(listDiscordChannels(), null, 2),
      }),

    discord_channel_note: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_channel_note",
        logArgKeys: ["channel_id"] as const,
        runArgKeys: ["channel_id", "note"] as const,
        run: async (channel_id, note) =>
          JSON.stringify(setDiscordChannelNote(channel_id as string, (note as string | undefined) ?? ""), null, 2),
      }),

    set_status: (ctx) =>
      runStandardTool(ctx, {
        name: "set_status",
        logArgKeys: ["text"] as const,
        runArgKeys: ["text"] as const,
        run: async (text) => {
          const customText = text ? String(text) : null
          setCustomStatus(customText)
          return customText
            ? `Custom status set: "${customText}". Auto info will be appended.`
            : "Custom status cleared. Showing auto info only."
        },
      }),

    subagent: async ({ convId, state, call, args }) => {
      const name = String(args.name ?? "").trim()
      const task = String(args.task ?? "").trim()
      const blocking = Boolean(args.blocking ?? false)

      if (!name) {
        recordToolResult(convId, state, call, "subagent", { name, task }, "error: subagent requires a name")
        return {}
      }
      if (!task) {
        recordToolResult(convId, state, call, "subagent", { name, task }, "error: subagent requires a task")
        return {}
      }

      const subagentConfig = findSubagent(name)
      if (!subagentConfig) {
        const available = config.subagents.map((sa) => sa.name).join(", ") || "(none configured)"
        recordToolResult(convId, state, call, "subagent", { name, task }, `error: no subagent named "${name}". available: ${available}`)
        return {}
      }

      if (blocking) {
        console.log(`[subagent] main agent spawning "${name}" (blocking) with task: ${task.slice(0, 200)}`)
        try {
          const result = await runSubagent(convId, subagentConfig, task)
          recordToolResult(convId, state, call, "subagent", { name, task: task.slice(0, 500), blocking: true }, result)
        } catch (err) {
          recordToolResult(convId, state, call, "subagent", { name, task: task.slice(0, 500), blocking: true }, toolError(err))
        }
      } else {
        const jobId = startJob(`subagent:${name}`, () => runSubagent(convId, subagentConfig, task))
        console.log(`[subagent] main agent spawned "${name}" as job ${jobId} with task: ${task.slice(0, 200)}`)
        recordToolResult(
          convId, state, call, "subagent",
          { name, task: task.slice(0, 500), blocking: false },
          `subagent "${name}" started as background job (${jobId}). you will be woken and notified when it completes.`,
        )
      }
      return {}
    },

    computer: async ({ convId, state, call, args }) => {
      if (!config.computer_use.enabled) {
        recordToolResult(convId, state, call, "computer", { action: args.action }, "error: computer_use is not enabled. set [computer_use] enabled = true in config.")
        return {}
      }

      console.log("[computer]", JSON.stringify(args))
      let result: string

      try {
        const res = await executeAction({
          action: String(args.action ?? ""),
          x: args.x as number | undefined,
          y: args.y as number | undefined,
          button: args.button as string | undefined,
          text: args.text as string | undefined,
          keys: args.keys as string[] | undefined,
          scroll_x: args.scroll_x as number | undefined,
          scroll_y: args.scroll_y as number | undefined,
          path: args.path as Array<[number, number]> | undefined,
          duration: args.duration as number | undefined,
        })

        result = pushToolMessage(convId, state, call, res.output)

        // If the action returned an image (screenshot), push it as a multimodal message
        if (res.image) {
          const commaIdx = res.image.dataUrl.indexOf(",")
          const mimeMatch = res.image.dataUrl.match(/data:([^;]+)/)
          const mimeType = mimeMatch?.[1] ?? res.image.mime
          const data = commaIdx >= 0 ? res.image.dataUrl.slice(commaIdx + 1) : res.image.dataUrl

          const imageMessage: PiUserMessage = {
            role: "user",
            content: [
              { type: "text", text: `[screenshot] ${res.image.path}` },
              { type: "image", data, mimeType },
            ],
            timestamp: Date.now(),
          }
          state.conversation.push(imageMessage)
          logMessage(convId, "user", `[computer] screenshot\npath=${res.image.path}`)
        }
      } catch (err) {
        result = recordToolResult(convId, state, call, "computer", { action: args.action }, toolError(err))
        return {}
      }

      emit({ type: "tool", name: "computer", args: { action: args.action }, result })
      return {}
    },
  }
}

