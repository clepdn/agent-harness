import type { UserMessage as PiUserMessage } from "../llm"
import { config } from "../config"
import { normalizeTimeoutMs } from "../container/config"
import type { ClientImageArtifact, ClientToolName } from "@nano/harness-protocol"
import { AGENT_ID } from "../agent-config"
import { grepMemory, listMemory, loadSkill, memoryFs, readMemory, editMemoryResource, editMemoryResourceHashline } from "../agent-state-tools"
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
import { pruneDiscordMemory, searchDiscordMessages, type MemoryPruneReason } from "../discord/search"
import { webSearch } from "../web-search"
import { emit } from "../stream"
import { stopDiscordTyping } from "../discord/typing-lease"
import type { ToolHandler } from "./loop-shared"
import type { LoopState } from "./types"
import { checkGitUpstream } from "./git-upstream-check"
import { GIT_UPSTREAM_NAG } from "./config"
import { pushToolMessage, recordToolResult, runStandardTool, toolError } from "./loop-tool-runtime"
import { findSubagent, runSubagent } from "./subagent"
import { cancelJob, forgetJob, getJob, listJobs, readJobStdout, runJobUntilDetached, startJob, type Job } from "./jobs"
import { describeContextSummary, expandContextSummary, grepContext } from "./context-store"
import { clearSession, saveRestSnapshot } from "./util"
import { compactForShutdown } from "./loop"
import { sendVoiceReply } from "../discord/voice"
import { listAgentChannelMessages, sendAgentChannelMessage } from "./agent-channel"
import type { MemoryAccessOptions } from "../agent-state-tools"
import { fetchRemoteImage, isRemoteImageUrl } from "../remote-image"

const DEFAULT_WAIT_THEN_CONTINUE_MS = 10_000
// Screenshot capture alone allows 30s at the client; keep the invocation
// deadline clear of it.
const COMPUTER_TIMEOUT_MS = 60_000
export const SHELL_DETACH_AFTER_MS = 120_000

function memoryAccessFor(state: { runtimeKind?: string }): MemoryAccessOptions | undefined {
  return state.runtimeKind === "frontend"
    ? { excludeSkills: true, excludeMainSessionArchives: true, allowLocalCopy: false, virtualizeSoul: true }
    : undefined
}

function memoryReadAccessFor(state: LoopState): MemoryAccessOptions {
  return { ...memoryAccessFor(state), hashline: editContractForState(state) !== "exact" }
}

function discordDeliveryToolResult(result: Record<string, unknown>): string {
  return JSON.stringify({
    ok: result.ok === true,
    reply_mode: result.reply_mode,
    replied: Boolean(result.used_reference_message_id),
    stored: result.stored === true,
    ...(typeof result.file_name === "string" ? { file_name: result.file_name } : {}),
    ...(typeof result.file_size === "number" ? { file_size: result.file_size } : {}),
  }, null, 2)
}

function jobView(job: Job): Record<string, unknown> {
  const finishedAt = job.completedAt ?? Date.now()
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    startedAt: new Date(job.startedAt).toISOString(),
    ...(job.completedAt ? { completedAt: new Date(job.completedAt).toISOString() } : {}),
    elapsedMs: Math.max(0, finishedAt - job.startedAt),
    stdoutLength: job.stdout.length,
    ...(job.error !== undefined ? { error: job.error } : {}),
  }
}

/**
 * Invoke a tool on the attached client. Undefined args are dropped so the
 * client sees only what the model actually supplied.
 */
async function runClientTool(
  tool: ClientToolName,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  onOutput?: (chunk: string) => void,
): Promise<string> {
  const supplied: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) supplied[key] = value
  }
  const result = await clientTools.execute({
    agentId: AGENT_ID,
    tool,
    args: supplied,
    ...(typeof args.timeout_ms === "number" ? { timeoutMs: args.timeout_ms } : {}),
    ...(signal ? { signal } : {}),
    ...(onOutput ? { onOutput } : {}),
  })
  if (result.status === "ok") return result.output ?? ""
  return result.output?.startsWith("error:") ? result.output : `error: ${result.output ?? `${tool} failed`}`
}

/**
 * Fetch an image artifact from the attached client. Throws so the caller's
 * existing catch records the failure as a tool error.
 */
async function runClientImageTool(path: string, timeoutMs?: number, signal?: AbortSignal): Promise<ClientImageArtifact> {
  const result = await clientTools.execute({
    agentId: AGENT_ID,
    tool: "image_tool",
    args: { path },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(signal ? { signal } : {}),
  })
  if (result.status !== "ok" || !result.image) throw new Error(result.output ?? "image_tool returned no image")
  return result.image
}

/**
 * Builds the function-tool handler table for the runner loop.
 */
function editContractForState(state: LoopState): "hashline" | "exact" | "legacy-both" {
  const definition = state.toolCatalog.find((tool) => tool.function.name === "edit_file")
  const properties = definition?.function.parameters.properties
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return "exact"
  const fields = properties as Record<string, unknown>
  const hasEdits = Object.prototype.hasOwnProperty.call(fields, "edits")
  const hasExact = Object.prototype.hasOwnProperty.call(fields, "old_text")
  if (hasEdits && !hasExact) return "hashline"
  if (hasExact && !hasEdits) return "exact"
  return "legacy-both"
}

export function buildToolHandlers(): Record<string, ToolHandler> {
  return {
    agent_send: (ctx) =>
      runStandardTool(ctx, {
        name: "agent_send",
        logArgKeys: [] as const,
        runArgKeys: ["content"] as const,
        run: async (content) => JSON.stringify(
          sendAgentChannelMessage(ctx.state.runtimeKind ?? "main", content),
          null,
          2,
        ),
      }),

    agent_channel: (ctx) =>
      runStandardTool(ctx, {
        name: "agent_channel",
        logArgKeys: ["limit", "before_id"] as const,
        runArgKeys: ["limit", "before_id"] as const,
        run: async (limit, beforeId) => JSON.stringify(
          listAgentChannelMessages({ limit, beforeId }),
          null,
          2,
        ),
      }),

    voice_reply: async ({ convId, state, call, args }) => {
      const delegationId = typeof args.delegation_id === "string" ? args.delegation_id : ""
      const inputText = typeof args.input_text === "string" ? args.input_text : ""
      const result = sendVoiceReply(delegationId, inputText)
      const output = result.ok ? `sent ${result.chunks} voice chunk(s)` : `voice reply rejected: ${result.error}`
      recordToolResult(convId, state, call, "voice_reply", args, output)
      return {}
    },

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

    wait: async ({ convId, state, call, args }) => {
      recordToolResult(convId, state, call, "wait", args, "Waiting for next event.")
      console.log("[runner] nano is waiting for next event...")
      // The outer runner wait owns idle-compaction timeouts. Yield to it instead
      // of blocking on the raw event hook here.
      return { shouldWaitForEvent: true }
    },

    end_session: async ({ convId, state, call, args }) => {
      if (args.note) console.log("[runner] end_session note:", args.note)
      recordToolResult(convId, state, call, "end_session", args, "Session ended.")
      // Save the raw snapshot FIRST as a guaranteed-continuity fallback, so if
      // the rich summary compaction is slow or fails, next boot still rehydrates
      // from the raw conversation instead of waking clean with nothing.
      const note = args.note as string | undefined
      await saveRestSnapshot(state.context.items, note, state.runtimeKind)
      // Then compact-and-resave so a clean goodbye leaves a real rich summary
      // behind. Best-effort: the raw snapshot above already guarantees continuity.
      try {
        const compacted = await compactForShutdown(state)
        if (compacted === "rewritten") {
          console.log("[runner] end_session compacted the conversation before resting")
          await saveRestSnapshot(state.context.items, note, state.runtimeKind)
        }
      } catch (err) {
        console.warn(`[runner] end_session compaction failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      // Actually END the session: delete the full-conversation session.json so
      // the next wake does NOT rehydrate verbatim via loadSession(). Without
      // this, end_session was indistinguishable from wait — the runtime
      // snapshot persisted and the next event restored the entire prior
      // context. Clearing it makes the next wake bootstrap fresh from just the
      // rest-snapshot summary.
      await clearSession(state.runtimeKind)
      console.log("[runner] end_session cleared session.json — next wake starts fresh")
      return { shouldRest: true }
    },

    shell: async (ctx) => {
      const { command, max_lines, timeout_ms, pty } = ctx.args
      console.log("[shell]", command, timeout_ms, pty)
      const displayName = `shell:${String(command ?? "").slice(0, 80)}`
      const outcome = await runJobUntilDetached(
        displayName,
        async (signal, onStdout) => {
          const output = await runClientTool("shell", { command, max_lines, timeout_ms, pty }, signal, onStdout)
          if (output.startsWith("error:")) throw new Error(output.replace(/^error:\s*/, ""))
          return output
        },
        ctx.state.operationSignal,
        SHELL_DETACH_AFTER_MS,
      )

      let content: string
      if (outcome.detached) {
        content = `shell command is still running and was detached as background job ${outcome.jobId}. use job_status to inspect it, job_stdout to read captured output, or job_cancel to stop it; completion or failure will wake you.`
      } else {
        const { job } = outcome
        content = job.status === "completed"
          ? job.result || "(no output)"
          : `error: ${job.error ?? `shell job ${job.status}`}`
        forgetJob(job.id)
      }
      console.log("[shell result]", content.slice(0, 200))
      recordToolResult(ctx.convId, ctx.state, ctx.call, "shell", ctx.args, content)
      return {}
    },

    job_list: (ctx) =>
      runStandardTool(ctx, {
        name: "job_list",
        logArgKeys: [] as const,
        runArgKeys: [] as const,
        run: async () => JSON.stringify({ jobs: listJobs().map((job) => jobView(job)) }, null, 2),
      }),

    job_status: (ctx) =>
      runStandardTool(ctx, {
        name: "job_status",
        logArgKeys: ["job_id"] as const,
        runArgKeys: ["job_id"] as const,
        run: async (jobId) => {
          const job = getJob(String(jobId ?? ""))
          if (!job) throw new Error(`job not found: ${String(jobId ?? "")}`)
          return JSON.stringify(jobView(job), null, 2)
        },
      }),

    job_stdout: (ctx) =>
      runStandardTool(ctx, {
        name: "job_stdout",
        logArgKeys: ["job_id", "start", "end", "max_chars"] as const,
        runArgKeys: ["job_id", "start", "end", "max_chars"] as const,
        run: async (jobId, start, end, maxChars) => JSON.stringify(
          readJobStdout(
            String(jobId ?? ""),
            start === undefined ? 0 : Number(start),
            end === undefined ? undefined : Number(end),
            maxChars === undefined ? 20_000 : Number(maxChars),
          ),
          null,
          2,
        ),
      }),

    job_cancel: (ctx) =>
      runStandardTool(ctx, {
        name: "job_cancel",
        logArgKeys: ["job_id"] as const,
        runArgKeys: ["job_id"] as const,
        run: async (jobId) => {
          const id = String(jobId ?? "")
          const result = cancelJob(id, "cancelled by job_cancel")
          if (result === "not-found") throw new Error(`job not found: ${id}`)
          if (result === "not-running") throw new Error(`job is not running: ${id}`)
          return JSON.stringify({ ok: true, job_id: id, status: "cancelled" })
        },
      }),

    read_file: async (ctx) => {
      const pathArg = ctx.args.path
      if (typeof pathArg !== "string" || !pathArg.trim()) {
        return runStandardTool(ctx, {
          name: "read_file", logArgKeys: ["path"] as const, runArgKeys: [] as const,
          run: async () => { throw new Error("path is required") }, emitArgKeys: ["path"] as const, previewChars: 0,
        })
      }
      if (pathArg.startsWith("memory://")) {
        return runStandardTool(ctx, {
          name: "read_file",
          logArgKeys: ["path", "start_line", "end_line"] as const,
          runArgKeys: ["path", "start_line", "end_line"] as const,
          run: (path, startLine, endLine) => readMemory(path, startLine, endLine, memoryReadAccessFor(ctx.state)),
        })
      }
      if (ctx.state.runtimeKind === "frontend") {
        return runStandardTool(ctx, {
          name: "read_file", logArgKeys: ["path"] as const, runArgKeys: [] as const,
          run: async () => { throw new Error("frontend read_file accepts only memory:// resources") }, emitArgKeys: ["path"] as const, previewChars: 0,
        })
      }
      if (!clientTools.getCapabilities().includes("read_file")) {
        return runStandardTool(ctx, {
          name: "read_file", logArgKeys: ["path"] as const, runArgKeys: [] as const,
          run: async () => { throw new Error("read_file is unavailable on the attached client") }, emitArgKeys: ["path"] as const, previewChars: 0,
        })
      }
      const result = await runStandardTool(ctx, {
        name: "read_file",
        logArgKeys: ["path", "start_line", "end_line", "timeout_ms"] as const,
        runArgKeys: ["path", "start_line", "end_line", "timeout_ms"] as const,
        run: (path, start_line, end_line, timeout_ms) =>
          runClientTool("read_file", { path, start_line, end_line, timeout_ms }, ctx.state.operationSignal),
        emptyFallback: "(empty file)",
      })
      if (GIT_UPSTREAM_NAG) {
        checkGitUpstream(ctx.args.path as string, ctx.convId, ctx.state)
      }
      return result
    },

    memory_fs: (ctx) =>
      runStandardTool(ctx, {
        name: "memory_fs",
        logArgKeys: ["file_name", "op", "target"] as const,
        runArgKeys: ["file_name", "op", "target"] as const,
        run: (fileName, op, target) => memoryFs(fileName, op, target, memoryAccessFor(ctx.state)),
        emitArgKeys: ["file_name"] as const,
        previewChars: 0,
      }),

    edit_file: async (ctx) => {
      const args = ctx.args
      const pathArg = args.path
      const declaredContract = editContractForState(ctx.state)
      const hasExact = Object.prototype.hasOwnProperty.call(args, "old_text") || Object.prototype.hasOwnProperty.call(args, "new_text")
      const hasHashline = Object.prototype.hasOwnProperty.call(args, "edits")
      const exactValid = typeof args.old_text === "string" && typeof args.new_text === "string"
      const hashlineValid = Array.isArray(args.edits) && args.edits.length > 0
      const exactRequest = hasExact && exactValid && !hasHashline
      const hashlineRequest = hasHashline && hashlineValid && !hasExact
      const contractValid = declaredContract === "hashline"
        ? hashlineRequest
        : declaredContract === "exact"
          ? exactRequest
          : exactRequest || hashlineRequest
      if (!contractValid) {
        return runStandardTool(ctx, {
          name: "edit_file",
          logArgKeys: ["path"] as const,
          runArgKeys: [] as const,
          run: async () => { throw new Error(declaredContract === "hashline"
            ? "edit_file requires a non-empty edits array while hashline mode is enabled"
            : declaredContract === "exact"
              ? "edit_file requires old_text/new_text while hashline mode is disabled"
              : "edit_file requires exactly one edit contract: old_text/new_text or a non-empty edits array") },
          emitArgKeys: ["path"] as const,
          previewChars: 0,
        })
      }
      if (typeof pathArg !== "string" || !pathArg.trim()) {
        return runStandardTool(ctx, {
          name: "edit_file", logArgKeys: ["path"] as const, runArgKeys: [] as const,
          run: async () => { throw new Error("path is required") }, emitArgKeys: ["path"] as const, previewChars: 0,
        })
      }
      if (pathArg.startsWith("memory://")) {
        return exactValid
          ? runStandardTool(ctx, {
              name: "edit_file", logArgKeys: ["path"] as const,
              runArgKeys: ["path", "old_text", "new_text", "expected_hash"] as const,
              run: (uri, oldText, newText, expectedHash) => editMemoryResource(uri, oldText, newText, expectedHash, memoryAccessFor(ctx.state)),
              emitArgKeys: ["path"] as const, previewChars: 0,
            })
          : runStandardTool(ctx, {
              name: "edit_file", logArgKeys: ["path"] as const,
              runArgKeys: ["path", "edits", "expected_hash"] as const,
              run: (uri, edits, expectedHash) => editMemoryResourceHashline(uri, edits, expectedHash, memoryAccessFor(ctx.state)),
              emitArgKeys: ["path"] as const, previewChars: 0,
            })
      }
      if (ctx.state.runtimeKind === "frontend") {
        return runStandardTool(ctx, {
          name: "edit_file", logArgKeys: ["path"] as const, runArgKeys: [] as const,
          run: async () => { throw new Error("frontend edit_file accepts only memory:// resources") }, emitArgKeys: ["path"] as const, previewChars: 0,
        })
      }
      if (!clientTools.getCapabilities().includes("edit_file")) {
        return runStandardTool(ctx, {
          name: "edit_file", logArgKeys: ["path"] as const, runArgKeys: [] as const,
          run: async () => { throw new Error("edit_file is unavailable on the attached client") }, emitArgKeys: ["path"] as const, previewChars: 0,
        })
      }
      const result = await runStandardTool(ctx, {
        name: "edit_file",
        logArgKeys: ["path", "timeout_ms"] as const,
        runArgKeys: ["path", "edits", "old_text", "new_text", "timeout_ms"] as const,
        run: (path, edits, old_text, new_text, timeout_ms) =>
          runClientTool("edit_file", { path, edits, old_text, new_text, timeout_ms }, ctx.state.operationSignal),
        emitArgKeys: ["path"] as const,
        previewChars: 0,
      })
      if (GIT_UPSTREAM_NAG) checkGitUpstream(pathArg, ctx.convId, ctx.state)
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
            results: await searchMemories(query as string, limit as number | undefined, ctx.state.runtimeKind),
            },
            null,
            2,
          ),
        emptyFallback: '{"query":"","results":[]}',
      }),

    memory_prune: (ctx) =>
      runStandardTool(ctx, {
        name: "memory_prune",
        logArgKeys: ["id", "reason", "note"] as const,
        runArgKeys: ["id", "reason", "note"] as const,
        run: async (id, reason, note) => JSON.stringify(
          pruneDiscordMemory(String(id ?? ""), String(reason ?? "") as MemoryPruneReason, note as string | undefined, ctx.state.runtimeKind),
          null,
          2,
        ),
      }),

    web_search: (ctx) =>
      runStandardTool(ctx, {
        name: "web_search",
        logArgKeys: ["query", "num_results", "include_text"] as const,
        runArgKeys: ["query", "num_results", "include_text"] as const,
        run: async (query, num_results, include_text) =>
          JSON.stringify(
            {
              query,
              results: await webSearch(
                query as string,
                num_results as number | undefined,
                Boolean(include_text),
              ),
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

    memory_read: (ctx) =>
      runStandardTool(ctx, {
        name: "memory_read",
        logArgKeys: ["path", "start_line", "end_line"] as const,
        runArgKeys: ["path", "start_line", "end_line"] as const,
        run: (path, startLine, endLine) => readMemory(path, startLine, endLine, memoryAccessFor(ctx.state)),
      }),

    memory_ls: (ctx) =>
      runStandardTool(ctx, {
        name: "memory_ls",
        logArgKeys: [] as const,
        runArgKeys: [] as const,
        run: () => listMemory(memoryAccessFor(ctx.state)),
      }),

    memory_grep: (ctx) =>
      runStandardTool(ctx, {
        name: "memory_grep",
        logArgKeys: ["query", "case_insensitive"] as const,
        runArgKeys: ["query", "case_insensitive"] as const,
        run: (query, caseInsensitive) => grepMemory(query, caseInsensitive, memoryAccessFor(ctx.state)),
      }),

    skill: (ctx) =>
      runStandardTool(ctx, {
        name: "skill",
        logArgKeys: ["name"] as const,
        runArgKeys: ["name"] as const,
        run: (name) => loadSkill(name),
      }),

    lcm_describe: (ctx) =>
      runStandardTool(ctx, {
        name: "lcm_describe",
        logArgKeys: ["id", "tokenCap"] as const,
        runArgKeys: ["id", "tokenCap"] as const,
        run: async (id, tokenCap) => {
          const summaryId = String(id ?? "").trim()
          return JSON.stringify(describeContextSummary(summaryId, tokenCap as number | undefined, ctx.state.runtimeKind) ?? {
            error: `unknown context summary: ${summaryId}`,
            hint: "Use context_grep to find archived evidence, or check the summary id from the active context marker.",
          }, null, 2)
        },
      }),

    context_grep: (ctx) =>
      runStandardTool(ctx, {
        name: "context_grep",
        logArgKeys: ["query", "summary_id", "limit"] as const,
        runArgKeys: ["query", "limit", "summary_id"] as const,
        run: async (query, limit, summaryId) =>
          JSON.stringify({
            query,
            summaryId: summaryId ?? null,
            results: grepContext(String(query ?? ""), limit as number | undefined, summaryId as string | undefined, ctx.state.runtimeKind),
          }, null, 2),
      }),

    context_expand: (ctx) =>
      runStandardTool(ctx, {
        name: "context_expand",
        logArgKeys: ["summary_id", "offset", "limit"] as const,
        runArgKeys: ["summary_id", "offset", "limit"] as const,
        run: async (summaryId, offset, limit) =>
          JSON.stringify(
            expandContextSummary(String(summaryId ?? ""), offset as number | undefined, limit as number | undefined, ctx.state.runtimeKind) ?? {
              error: `unknown context summary: ${String(summaryId ?? "")}`,
            },
            null,
            2,
          ),
      }),

    image_tool: async ({ convId, state, call, args }) => {
      console.log("[image_tool]", args.path, args.timeout_ms)
      let result: string

      try {
        const imageInput = String(args.path ?? "").trim()
        if (!imageInput) throw new Error("image_tool requires a path or HTTP(S) URL")
        if (/^[a-z][a-z\d+.-]*:\/\//i.test(imageInput) && !isRemoteImageUrl(imageInput)) {
          throw new Error("image_tool URLs must use HTTP or HTTPS")
        }
        const timeoutMs = normalizeTimeoutMs(args.timeout_ms as number | undefined, 120_000)
        let image: ClientImageArtifact
        if (isRemoteImageUrl(imageInput)) {
          image = await fetchRemoteImage(
            imageInput,
            state.operationSignal
              ? AbortSignal.any([state.operationSignal, AbortSignal.timeout(timeoutMs)])
              : AbortSignal.timeout(timeoutMs),
          )
        } else {
          if (state.runtimeKind === "frontend") throw new Error("frontend image_tool accepts HTTP(S) image URLs only")
          image = await runClientImageTool(imageInput, timeoutMs, state.operationSignal)
        }
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
        state.context.append(imageMessage)
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
              runtimeKind: ctx.state.runtimeKind,
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
            listDiscordInbox(limit as number | undefined, status as string | string[] | undefined, ctx.state.runtimeKind),
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
              ctx.state.runtimeKind,
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
            ctx.state.runtimeKind,
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

    discord_search: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_search",
        logArgKeys: ["channel_id", "query", "message_id", "limit"] as const,
        runArgKeys: ["channel_id", "query", "message_id", "limit"] as const,
        run: async (channelId, query, messageId, limit) =>
          JSON.stringify(
            await searchDiscordMessages({
              channelId: String(channelId ?? ""),
              ...(query ? { query: String(query) } : {}),
              ...(messageId ? { messageId: String(messageId) } : {}),
              ...(typeof limit === "number" ? { limit } : {}),
              runtimeKind: ctx.state.runtimeKind,
            }),
            null,
            2,
          ),
      }),

    discord_send: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_send",
        logArgKeys: ["target", "reply_mode"] as const,
        runArgKeys: ["channel_id", "content", "target", "reply_mode", "source_item_id", "reference_message"] as const,
        run: async (channel_id, content, target, reply_mode, source_item_id, reference_message) => {
          try {
            return discordDeliveryToolResult(
              await sendDiscordMessage({
                channelId: channel_id as string,
                content: content as string,
                target,
                turnTargets: ctx.state.discordTargets,
                sourceItemId: source_item_id as string | undefined,
                replyMode: reply_mode as string | undefined,
                referenceMessage: reference_message as string | undefined,
                runtimeKind: ctx.state.runtimeKind,
              }),
            )
          } finally {
            stopDiscordTyping(ctx.state.discordTypingTurnId)
            ctx.state.discordTypingTurnId = undefined
            ctx.state.discordTypingChannelId = undefined
          }
        }
      }),

    discord_upload: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_upload",
        logArgKeys: ["file_path", "target", "reply_mode"] as const,
        runArgKeys: ["channel_id", "file_path", "content", "target", "reply_mode", "source_item_id", "reference_message"] as const,
        run: async (channel_id, file_path, content, target, reply_mode, source_item_id, reference_message) =>
          discordDeliveryToolResult(
            await uploadDiscordFile({
              channelId: channel_id as string,
              filePath: file_path as string,
              content: content as string | undefined,
              target,
              turnTargets: ctx.state.discordTargets,
              sourceItemId: source_item_id as string | undefined,
              replyMode: reply_mode as string | undefined,
              referenceMessage: reference_message as string | undefined,
              runtimeKind: ctx.state.runtimeKind,
            }),
          ),
      }),

    discord_channels: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_channels",
        logArgKeys: [] as const,
        runArgKeys: [] as const,
        run: async () => JSON.stringify(listDiscordChannels(ctx.state.runtimeKind), null, 2),
      }),

    discord_channel_note: (ctx) =>
      runStandardTool(ctx, {
        name: "discord_channel_note",
        logArgKeys: ["channel_id"] as const,
        runArgKeys: ["channel_id", "note"] as const,
        run: async (channel_id, note) =>
          JSON.stringify(setDiscordChannelNote(channel_id as string, (note as string | undefined) ?? "", ctx.state.runtimeKind), null, 2),
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
          const result = await runSubagent(convId, subagentConfig, task, state.operationSignal)
          recordToolResult(convId, state, call, "subagent", { name, task: task.slice(0, 500), blocking: true }, result)
        } catch (err) {
          recordToolResult(convId, state, call, "subagent", { name, task: task.slice(0, 500), blocking: true }, toolError(err))
        }
      } else {
        const jobId = startJob(`subagent:${name}`, (signal) => runSubagent(convId, subagentConfig, task, signal))
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
        // Runs on the attached client, so the X display driven is the
        // executor's. `display` rides along because the config naming it lives
        // here on the control plane, not out at the executor.
        const res = await clientTools.execute({
          agentId: AGENT_ID,
          tool: "computer",
          args: {
            ...args,
            ...(config.computer_use.display ? { display: config.computer_use.display } : {}),
          },
          timeoutMs: COMPUTER_TIMEOUT_MS,
          ...(state.operationSignal ? { signal: state.operationSignal } : {}),
        })
        if (res.status !== "ok") throw new Error(res.output ?? "computer action failed")

        const image = res.image
        result = pushToolMessage(
          convId,
          state,
          call,
          image ? `screenshot captured (${image.bytes} bytes)` : res.output || "(no output)",
        )

        // If the action returned an image (screenshot), push it as a multimodal message
        if (image) {
          const commaIdx = image.dataUrl.indexOf(",")
          const mimeMatch = image.dataUrl.match(/data:([^;]+)/)
          const mimeType = mimeMatch?.[1] ?? image.mime
          const data = commaIdx >= 0 ? image.dataUrl.slice(commaIdx + 1) : image.dataUrl

          const imageMessage: PiUserMessage = {
            role: "user",
            content: [
              { type: "text", text: `[screenshot] ${image.path}` },
              { type: "image", data, mimeType },
            ],
            timestamp: Date.now(),
          }
          state.context.append(imageMessage)
          logMessage(convId, "user", `[computer] screenshot\npath=${image.path}`)
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
