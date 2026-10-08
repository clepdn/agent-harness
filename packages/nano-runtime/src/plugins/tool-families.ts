import { posix } from "node:path"
import type { Plugin } from "@nano/plugins"
import { createClientToolCatalog, createReadFileToolDefinition, type JsonSchema, type ToolDefinition } from "@nano/harness-core"
import type { UserMessage } from "../llm"
import type {
  AgentChannelService, ClientService, DiscordService, JobsService, MemoryService, PersistenceService,
  SubagentService, ToolCatalogContext, ToolContribution, ToolContributionContext, WebSearchService,
} from "./api"
import { nano, registerTool } from "./api"
import { AGENT_ID } from "../agent-config"
import { normalizeTimeoutMs } from "../container/config"
import { pushToolMessage, runStandardTool } from "../runner/loop-tool-runtime"
import type { ToolExecutionOutcome } from "../runner/loop-shared"
import type { LoopState, RuntimeKind } from "../runner/types"
import { GIT_UPSTREAM_NAG } from "../runner/config"
import { createGitUpstreamChecker } from "../runner/git-upstream-check"
import { compactForShutdown } from "../runner/loop"

type Properties = Record<string, unknown>
function schema(properties: Properties = {}, required?: string[]): JsonSchema {
  return { type: "object", additionalProperties: false, properties, ...(required ? { required } : {}) } as JsonSchema
}
type ContributionOptions = Partial<Pick<ToolContribution, "definitionFor" | "availableFor" | "runtimeKinds" | "clientCapabilities" | "requiresVision" | "requiresComputer">>
function toolDefinition(name: string, description: string, properties: Properties = {}, required?: string[]): ToolDefinition {
  return { type: "function", function: { name, description, parameters: schema(properties, required) } }
}
function contribution(name: string, description: string, execute: ToolContribution["execute"], properties: Properties = {}, required?: string[], options?: ContributionOptions): ToolContribution {
  return { definition: toolDefinition(name, description, properties, required), execute, ...options }
}
function kind(context: ToolContributionContext): RuntimeKind { return context.runtimeKind ?? context.state.runtimeKind ?? "main" }
function access(context: ToolContributionContext): Record<string, unknown> {
  const definition = context.state.toolCatalog.find((tool) => tool.function.name === "edit_file")
  const required = definition?.function.parameters.required
  const hashline = Array.isArray(required) && required.includes("edits")
  return { hashline, ...(kind(context) === "frontend" ? { excludeSkills: true, excludeMainSessionArchives: true, allowLocalCopy: false, virtualizeSoul: true } : {}) }
}
function json(value: unknown): string { return JSON.stringify(value, null, 2) }
function standard(context: ToolContributionContext, spec: Parameters<typeof runStandardTool>[1]): Promise<ToolExecutionOutcome> {
  return runStandardTool({ ...context, args: context.args }, spec)
}
function clientOutput(result: { status: string; output?: string }): string {
  if (result.status === "ok") return result.output ?? ""
  throw new Error(result.output ?? "client tool failed")
}
function appendImageMessage(context: ToolContributionContext, image: { path: string; mime: string; dataUrl?: string }, note?: string): void {
  if (!image.dataUrl) return
  const comma = image.dataUrl.indexOf(",")
  const data = comma >= 0 ? image.dataUrl.slice(comma + 1) : image.dataUrl
  const mimeType = image.dataUrl.match(/^data:([^;]+)/)?.[1] ?? image.mime
  const message: UserMessage = { role: "user", content: [{ type: "text", text: note?.trim() || `Please inspect this image: ${image.path}` }, { type: "image", data, mimeType }], timestamp: Date.now() }
  context.state.context.append(message)
  const first = Array.isArray(message.content) ? message.content[0] : undefined
  context.state.services?.persistence?.logMessage(context.convId, "user", `[image_tool] ${first?.type === "text" ? first.text : image.path}\npath=${image.path}`)
}

function memoryReadDefinition(ctx: ToolCatalogContext): ToolDefinition {
  const definition = createReadFileToolDefinition({ memory: true, hashline: ctx.workspace?.hashline === true })
  return definition
}
const HASHLINE_EDIT_PROPERTIES: Properties = {
  path: { type: "string", description: "Client path or memory:// Markdown URI." },
  edits: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { op: { type: "string", enum: ["replace", "append", "prepend", "replace_text"] }, pos: { type: "string" }, end: { type: "string" }, lines: { type: "array", items: { type: "string" } }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["op"] } },
  expected_hash: { type: "string" }, timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
}
const EXACT_EDIT_PROPERTIES: Properties = {
  path: { type: "string", description: "Client path or memory:// Markdown URI." }, old_text: { type: "string" }, new_text: { type: "string" }, expected_hash: { type: "string" }, timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
}
function memoryEditDefinition(ctx: ToolCatalogContext): ToolDefinition {
  const hashline = ctx.workspace?.hashline === true
  return toolDefinition("edit_file", "Edit a client file or memory:// Markdown resource.", hashline ? HASHLINE_EDIT_PROPERTIES : EXACT_EDIT_PROPERTIES, hashline ? ["path", "edits"] : ["path", "old_text", "new_text"])
}

function memoryTools(memory: MemoryService, checkGitUpstream: ((filePath: string, convId: number, state: LoopState, signal: AbortSignal) => Promise<void>) | undefined, discord?: DiscordService): ToolContribution[] {
  const read = contribution("read_file", "Read a client file or server-owned memory:// resource.", async (input, context) => {
    const path = String(input.path ?? "")
    if (!path.trim()) throw new Error("path is required")
    if (path.startsWith("memory://") || kind(context) === "frontend") return standard(context, { name: "read_file", logArgKeys: ["path", "start_line", "end_line"] as const, runArgKeys: ["path", "start_line", "end_line"] as const, run: (p, start, end) => memory.readMemory(p, start, end, access(context)) })
    const client = context.state.services?.client
    if (!client || !client.capabilities().includes("read_file")) throw new Error("read_file is unavailable on the attached client")
    const output = await standard(context, { name: "read_file", logArgKeys: ["path", "start_line", "end_line", "timeout_ms"] as const, runArgKeys: ["path", "start_line", "end_line", "timeout_ms"] as const, run: async (p, start, end, timeout) => clientOutput(await client.execute({ agentId: AGENT_ID, tool: "read_file", args: { path: p, start_line: start, end_line: end, timeout_ms: timeout }, timeoutMs: normalizeTimeoutMs(timeout as number | undefined, 120_000), signal: context.signal })), emptyFallback: "(empty file)" })
    await checkGitUpstream?.(path, context.convId, context.state, context.signal)
    return output
  }, { path: { type: "string" }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 }, timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 } }, ["path"], { definitionFor: memoryReadDefinition })
  const edit = contribution("edit_file", "Edit a client file or memory:// Markdown resource.", async (input, context) => {
    const path = String(input.path ?? "")
    const exact = typeof input.old_text === "string" && typeof input.new_text === "string"
    if (!path.trim()) throw new Error("path is required")
    const hashline = access(context).hashline === true
    if (hashline ? exact || !Array.isArray(input.edits) || input.edits.length === 0 : !exact || input.edits !== undefined) {
      throw new Error(hashline ? "edit_file requires a non-empty edits array in hashline mode" : "edit_file requires old_text/new_text in exact mode")
    }
    if (path.startsWith("memory://") || kind(context) === "frontend") {
      if (!path.startsWith("memory://")) throw new Error("frontend edit_file accepts only memory:// resources")
      const output = await standard(context, exact ? { name: "edit_file", logArgKeys: ["path"] as const, runArgKeys: ["path", "old_text", "new_text", "expected_hash"] as const, run: (p, oldText, newText, expected) => memory.editMemoryResource(p, oldText, newText, expected, access(context)) } : { name: "edit_file", logArgKeys: ["path"] as const, runArgKeys: ["path", "edits", "expected_hash"] as const, run: (p, edits, expected) => memory.editMemoryResourceHashline(p, edits, expected, access(context)) })
      const journalPath = posix.normalize(String(input.path).slice("memory://".length).replace(/\\/g, "/"))
      const result = context.state.context.items.at(-1)
      if (context.state.modelSwap && journalPath.startsWith("journal/") && result?.role === "toolResult" && result.toolCallId === context.call.id && !result.isError) context.state.modelSwap.journaled = true
      return output
    }
    const client = context.state.services?.client
    if (!client || !client.capabilities().includes("edit_file")) throw new Error("edit_file is unavailable on the attached client")
    const output = await standard(context, { name: "edit_file", logArgKeys: ["path", "timeout_ms"] as const, runArgKeys: ["path", "edits", "old_text", "new_text", "timeout_ms"] as const, run: async (p, edits, oldText, newText, timeout) => clientOutput(await client.execute({ agentId: AGENT_ID, tool: "edit_file", args: { path: p, edits, old_text: oldText, new_text: newText, timeout_ms: timeout }, timeoutMs: normalizeTimeoutMs(timeout as number | undefined, 120_000), signal: context.signal })) })
    await checkGitUpstream?.(path, context.convId, context.state, context.signal)
    return output
  }, EXACT_EDIT_PROPERTIES, ["path"], { definitionFor: memoryEditDefinition })
  const tools: ToolContribution[] = [
    read, edit,
    contribution("memory_fs", "Manage files and directories in server-owned memory.", (_input, context) => standard(context, { name: "memory_fs", logArgKeys: ["file_name", "op", "target"] as const, runArgKeys: ["file_name", "op", "target"] as const, run: (file, op, target) => memory.memoryFs(file, op, target, access(context)), emitArgKeys: ["file_name"] as const, previewChars: 0 }), { file_name: { type: "string" }, op: { type: "string", enum: ["ls", "create", "delete", "move", "copy"] }, target: { type: "string" } }, ["file_name", "op"]),
    contribution("memory_search", "Search indexed long-term memories from authored notes and the Discord vector index. Discord results include an id accepted by memory_prune.", (_input, context) => standard(context, { name: "memory_search", logArgKeys: ["query", "limit"] as const, runArgKeys: ["query", "limit"] as const, run: async (query, limit) => json({ query, results: await memory.search(String(query), limit as number | undefined, kind(context)) }), emptyFallback: '{"query":"","results":[]}'}), { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } }, ["query"]),
    contribution("memory_grep", "Search memories using exact substring matching.", (_input, context) => standard(context, { name: "memory_grep", logArgKeys: ["query", "case_insensitive"] as const, runArgKeys: ["query", "case_insensitive"] as const, run: (query, insensitive) => memory.grepMemory(query, insensitive, access(context)) }), { query: { type: "string" }, case_insensitive: { type: "boolean" } }, ["query"]),
    contribution("memory_alias", "Manage handle aliases used for memory recall.", (_input, context) => standard(context, { name: "memory_alias", logArgKeys: ["action", "handle", "canonical"] as const, runArgKeys: ["action", "handle", "canonical"] as const, run: async (action, handle, canonical) => { const op = String(action).toLowerCase(); if (op === "list") return json({ ok: true, aliases: await memory.listAliases() }); if (op === "set") return json({ ok: true, aliases: await memory.setAlias(String(handle), String(canonical)) }); if (op === "remove") return json({ ok: true, aliases: await memory.removeAlias(String(handle), canonical === undefined ? undefined : String(canonical)) }); return json({ ok: false, error: `unknown action: ${op}` }) } }), { action: { type: "string", enum: ["set", "remove", "list"] }, handle: { type: "string" }, canonical: { type: "string" } }, ["action"]),
    contribution("skill", "Load a skill doc from memories/skills/ into context.", (_input, context) => standard(context, { name: "skill", logArgKeys: ["name"] as const, runArgKeys: ["name"] as const, run: name => memory.loadSkill(name) }), { name: { type: "string" } }, ["name"], { runtimeKinds: ["main"] }),
  ]
  if (discord) tools.splice(3, 0, contribution("memory_prune", "Permanently delete one locally stored Discord message and its vector-memory entry by the id returned from memory_search. Use ONLY when explicitly requested or clearly wrong, bad, or stale.", (_input, context) => standard(context, { name: "memory_prune", logArgKeys: ["id", "reason"] as const, runArgKeys: ["id", "reason", "note"] as const, run: (id, reason, note) => discord.pruneDiscordMemory(String(id), reason as "explicit_request" | "surfaced_incorrect" | "surfaced_stale", note as string | undefined, kind(context)) }), { id: { type: "string", pattern: "^discord:[0-9]+$" }, reason: { type: "string", enum: ["explicit_request", "surfaced_incorrect", "surfaced_stale"] }, note: { type: "string" } }, ["id", "reason"], { availableFor: () => discord.available }))
  return tools
}

function discordTools(discord: DiscordService): ToolContribution[] {
  const target = { oneOf: [{ type: "integer", minimum: 1 }, { type: "string", minLength: 1 }], description: "Shown target number, id, or message-text prefix." }
  const sendProperties = { channel_id: { type: "string", description: "Discord channel id or a shown message id." }, content: { type: "string", description: "Message content to send." }, target, reply_mode: { type: "string", enum: ["auto", "plain", "explicit"] }, reference_message: { type: "string", description: "Message id, shown id, text prefix, or author name." } }
  const tools: ToolContribution[] = [
    contribution("discord_scan", "Scan configured Discord channels and ingest messages into the local Discord inbox database.", (_input, context) => standard(context, { name: "discord_scan", logArgKeys: ["limit", "before_message_id"] as const, runArgKeys: ["limit", "channel_ids", "before_message_id"] as const, run: (limit, ids, before) => discord.scanDiscordChannels({ limit: limit as number | undefined, channelIds: ids as string[] | string | undefined, beforeMessageId: before as string | undefined, runtimeKind: kind(context) }) }), { limit: { type: "integer", minimum: 1, maximum: 100 }, channel_ids: { type: "array", items: { type: "string" } }, before_message_id: { type: "string" } }),
    contribution("discord_inbox", "List Discord inbox items tracked in local state.", (_input, context) => standard(context, { name: "discord_inbox", logArgKeys: ["limit", "status"] as const, runArgKeys: ["limit", "status"] as const, run: (limit, status) => discord.listDiscordInbox(limit as number | undefined, status as string | string[] | undefined, kind(context)) }), { limit: { type: "integer", minimum: 1, maximum: 200 }, status: { type: "string" } }),
    contribution("discord_backread", "Read stored Discord message history for a channel from local state, newest first.", (_input, context) => standard(context, { name: "discord_backread", logArgKeys: ["channel_id", "limit", "before_message_id"] as const, runArgKeys: ["channel_id", "limit", "before_message_id"] as const, run: (channel, limit, before) => discord.listDiscordBackread(String(channel), limit as number | undefined, before as string | undefined, kind(context)) }), { channel_id: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 }, before_message_id: { type: "string" } }, ["channel_id"]),
    contribution("discord_search", "Search stored Discord messages in one channel by semantic text or exact message id.", (_input, context) => standard(context, { name: "discord_search", logArgKeys: ["channel_id", "query", "message_id", "limit"] as const, runArgKeys: ["channel_id", "query", "message_id", "limit"] as const, run: (channel, query, messageId, limit) => discord.searchDiscordMessages({ channelId: String(channel), query: query as string | undefined, messageId: messageId as string | undefined, limit: limit as number | undefined, runtimeKind: kind(context) }) }), { channel_id: { type: "string" }, query: { type: "string" }, message_id: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["channel_id"]),
    contribution("discord_send", "Send a Discord message. Omit target to answer the latest surfaced message.", (_input, context) => standard(context, { name: "discord_send", logArgKeys: ["channel_id", "content", "target", "reply_mode"] as const, runArgKeys: ["channel_id", "content", "target", "reply_mode", "reference_message"] as const, run: (channel, content, targetValue, mode, reference) => discord.sendDiscordMessage({ channelId: channel as string | undefined, content: String(content), target: targetValue, replyMode: mode as string | undefined, referenceMessage: reference as string | undefined, turnTargets: context.state.discordTargets, runtimeKind: kind(context) }) }), sendProperties, ["content"]),
    contribution("discord_upload", "Upload a file to a Discord channel, optionally with a text caption.", (_input, context) => standard(context, { name: "discord_upload", logArgKeys: ["file_path", "target", "reply_mode"] as const, runArgKeys: ["channel_id", "file_path", "content", "target", "reply_mode", "source_item_id", "reference_message"] as const, run: async (channel, file, content, targetValue, mode, source, reference) => json(await discord.uploadDiscordFile({ channelId: channel as string, filePath: file as string, content: typeof content === "string" ? content : "", target: targetValue, turnTargets: context.state.discordTargets, sourceItemId: source as string | undefined, replyMode: mode as string | undefined, referenceMessage: reference as string | undefined, runtimeKind: kind(context) })) }), { channel_id: { type: "string" }, file_path: { type: "string" }, content: { type: "string" }, target, reply_mode: { type: "string", enum: ["auto", "plain", "explicit"] }, source_item_id: { type: "string" }, reference_message: { type: "string" } }, ["file_path"], { runtimeKinds: ["main"] }),
    contribution("discord_channels", "List configured Discord channels and DM channels with stored interactions.", (_input, context) => standard(context, { name: "discord_channels", logArgKeys: [] as const, runArgKeys: [] as const, run: () => discord.listDiscordChannels(kind(context)) })),
    contribution("discord_channel_note", "Set or clear a persistent note for a Discord channel id.", (_input, context) => standard(context, { name: "discord_channel_note", logArgKeys: ["channel_id"] as const, runArgKeys: ["channel_id", "note"] as const, run: (channel, note) => discord.setDiscordChannelNote(String(channel), String(note ?? ""), kind(context)) }), { channel_id: { type: "string" }, note: { type: "string" } }, ["channel_id", "note"]),
    contribution("discord_mark", "Set decision state for a Discord inbox item.", (_input, context) => standard(context, { name: "discord_mark", logArgKeys: ["item_id", "status", "action"] as const, runArgKeys: ["item_id", "status", "note", "action"] as const, run: (id, status, note, action) => discord.markDiscordItem(String(id), status as "pending" | "seen" | "acted" | "ignored", note as string | undefined, action as "none" | "replied" | "messaged" | "dismissed" | "noted" | undefined, kind(context)) }), { item_id: { type: "string" }, status: { type: "string", enum: ["pending", "seen", "acted", "ignored"] }, action: { type: "string", enum: ["none", "replied", "messaged", "dismissed", "noted"] }, note: { type: "string" } }, ["item_id", "status"]),
    contribution("set_status", "Set your own Discord custom status text; empty clears it.", (_input, context) => standard(context, { name: "set_status", logArgKeys: ["text"] as const, runArgKeys: ["text"] as const, run: text => { discord.setCustomStatus(text == null ? null : String(text)); return { ok: true } } }), { text: { type: "string" } }),
  ]
  return tools.map(entry => ({ ...entry, availableFor: () => discord.available }))
}

function clientFileTools(client: ClientService, checkGitUpstream: ((filePath: string, convId: number, state: LoopState, signal: AbortSignal) => Promise<void>) | undefined): ToolContribution[] {
  return (["read_file", "edit_file"] as const).map((name) => contribution(name, `${name} on the attached client.`, async (input, context) => {
    const result = await standard(context, {
      name, logArgKeys: ["path"] as const, runArgKeys: [] as const,
      run: async () => clientOutput(await client.execute({ agentId: AGENT_ID, tool: name, args: input, timeoutMs: normalizeTimeoutMs(input.timeout_ms as number | undefined, 120_000), signal: context.signal })),
    })
    await checkGitUpstream?.(String(input.path ?? ""), context.convId, context.state, context.signal)
    return result
  }, {}, undefined, {
    runtimeKinds: ["main"], clientCapabilities: [name],
    definitionFor: (context) => {
      const definition = createClientToolCatalog({ clientCapabilities: context.clientCapabilities, workspace: context.workspace }).find((tool) => tool.function.name === name)
      if (!definition) throw new Error(`Client capability ${name} has no tool definition`)
      return definition
    },
  }))
}

function clientTools(client: ClientService, images?: { fetchRemoteImage(url: string, signal?: AbortSignal): Promise<{ path: string; mime: string; bytes: number; dataUrl?: string }> }): ToolContribution[] {
  const clientDefinition = (name: string, ctx: ToolCatalogContext): ToolDefinition => {
    const definition = createClientToolCatalog({ clientCapabilities: ctx.clientCapabilities, workspace: ctx.workspace }).find(tool => tool.function.name === name)
    if (!definition) throw new Error(`Client capability ${name} has no tool definition`)
    return definition
  }
  return [
    contribution("shell", "Execute a bash command in a fresh process.", async (_input, context) => { const jobs = context.state.services?.jobs; if (!jobs) throw new Error("shell requires the jobs service"); return standard(context, { name: "shell", logArgKeys: ["command", "timeout_ms", "pty"] as const, runArgKeys: ["command", "max_lines", "timeout_ms", "pty"] as const, run: async (command, max, timeout, pty) => { const outcome = await jobs.runJobUntilDetached(`shell:${String(command ?? "").slice(0, 80)}`, async (signal, onStdout) => clientOutput(await client.execute({ agentId: AGENT_ID, tool: "shell", args: { command, max_lines: max, timeout_ms: timeout, pty }, timeoutMs: normalizeTimeoutMs(timeout as number | undefined, 120_000), signal, onOutput: onStdout })), context.signal, 120_000); if (outcome.detached) return `shell command is still running as background job ${outcome.jobId}.`; const result = outcome.job.status === "completed" ? outcome.job.result || "(no output)" : `error: ${outcome.job.error ?? `shell job ${outcome.job.status}`}`; jobs.forgetJob(outcome.job.id); return result } }) }, {}, [], { definitionFor: ctx => clientDefinition("shell", ctx), clientCapabilities: ["shell"], runtimeKinds: ["main"] }),
    contribution("computer", "Interact with the configured graphical desktop.", (input, context) => standard(context, { name: "computer", logArgKeys: ["action"] as const, runArgKeys: ["action"] as const, run: async () => { const result = await client.execute({ agentId: AGENT_ID, tool: "computer", args: input, timeoutMs: 60_000, signal: context.signal }); if (result.status !== "ok") throw new Error(result.output ?? "computer action failed"); if (result.image) appendImageMessage(context, result.image, `[screenshot] ${result.image.path}`); return result.output ?? "(no output)" } }), { action: { type: "string", enum: ["screenshot", "click", "double_click", "scroll", "type", "keypress", "drag", "move", "wait"] }, x: { type: "integer" }, y: { type: "integer" }, button: { type: "string", enum: ["left", "right", "middle"] }, text: { type: "string" }, keys: { type: "array", items: { type: "string" } }, scroll_x: { type: "integer" }, scroll_y: { type: "integer" }, path: { type: "array", items: { type: "array", items: { type: "integer" } } }, duration: { type: "integer" } }, ["action"], { clientCapabilities: ["computer"], requiresComputer: true, runtimeKinds: ["main"] }),
    contribution("image_tool", "Attach an image from a public HTTP(S) URL or a client file.", (input, context) => { const imagePath = String(input.path ?? "").trim(); if (/^https?:\/\//i.test(imagePath)) { if (!images) throw new Error("remote image service is unavailable"); return standard(context, { name: "image_tool", logArgKeys: ["path"] as const, runArgKeys: [] as const, run: async () => { const image = await images.fetchRemoteImage(imagePath, context.signal); appendImageMessage(context, image, String(input.note ?? "")); return `attached ${image.path} (${image.mime}, ${image.bytes} bytes)` }, previewChars: 0 }) } if (kind(context) === "frontend") throw new Error("frontend image_tool accepts only HTTP(S) URLs"); return standard(context, { name: "image_tool", logArgKeys: ["path"] as const, runArgKeys: ["path"] as const, run: async () => { const result = await client.execute({ agentId: AGENT_ID, tool: "image_tool", args: input, timeoutMs: normalizeTimeoutMs(input.timeout_ms as number | undefined, 120_000), signal: context.signal }); if (result.status !== "ok" || !result.image) throw new Error(result.output ?? "image_tool returned no image"); appendImageMessage(context, result.image, String(input.note ?? "")); return `attached ${result.image.path} (${result.image.mime}, ${result.image.bytes} bytes)` } }) }, { path: { type: "string" }, note: { type: "string" }, detail: { type: "string", enum: ["auto", "low", "high"] }, timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 } }, ["path"], { availableFor: ctx => ctx.runtimeKind === "frontend" ? Boolean(images) : Boolean(images) || ctx.clientCapabilities.has("image_tool"), definitionFor: ctx => toolDefinition("image_tool", ctx.runtimeKind === "frontend" ? "Attach an image from a public HTTP(S) URL." : "Attach an image from a public HTTP(S) URL or a client file.", { path: ctx.runtimeKind === "frontend" ? { type: "string", pattern: "^https?://" } : { type: "string" }, note: { type: "string" }, detail: { type: "string", enum: ["auto", "low", "high"] }, timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 } }, ["path"]), requiresVision: true }),
  ]
}
function imageOnlyTools(images: { fetchRemoteImage(url: string, signal?: AbortSignal): Promise<{ path: string; mime: string; bytes: number; dataUrl?: string }> }): ToolContribution[] {
  return [contribution("image_tool", "Attach an image from a public HTTP(S) URL.", (input, context) => standard(context, { name: "image_tool", logArgKeys: ["path"] as const, runArgKeys: [] as const, run: async () => { const image = await images.fetchRemoteImage(String(input.path), context.signal); appendImageMessage(context, image, String(input.note ?? "")); return `attached ${image.path} (${image.mime}, ${image.bytes} bytes)` }, previewChars: 0 }), { path: { type: "string" }, note: { type: "string" } }, ["path"], { requiresVision: true })]
}
function jobsTools(jobs: JobsService): ToolContribution[] {
  return [
    contribution("job_list", "List background jobs and their current status.", (_input, context) => standard(context, { name: "job_list", logArgKeys: [] as const, runArgKeys: [] as const, run: () => ({ jobs: jobs.listJobs() }) }), {}, [], { runtimeKinds: ["main"] }),
    contribution("job_status", "Inspect one background job.", (_input, context) => standard(context, { name: "job_status", logArgKeys: ["job_id"] as const, runArgKeys: ["job_id"] as const, run: id => { const job = jobs.getJob(String(id)); if (!job) throw new Error(`job not found: ${String(id)}`); return job } }), { job_id: { type: "string" } }, ["job_id"], { runtimeKinds: ["main"] }),
    contribution("job_stdout", "Read captured stdout from a background job.", (_input, context) => standard(context, { name: "job_stdout", logArgKeys: ["job_id", "start", "end", "max_chars"] as const, runArgKeys: ["job_id", "start", "end", "max_chars"] as const, run: (id, start, end, max) => jobs.readJobStdout(String(id), start === undefined ? 0 : Number(start), end === undefined ? undefined : Number(end), max === undefined ? 20_000 : Number(max)) }), { job_id: { type: "string" }, start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 0 }, max_chars: { type: "integer", minimum: 1, maximum: 100000 } }, ["job_id"], { runtimeKinds: ["main"] }),
    contribution("job_cancel", "Cancel a running background job.", (_input, context) => standard(context, { name: "job_cancel", logArgKeys: ["job_id"] as const, runArgKeys: ["job_id"] as const, run: id => { const result = jobs.cancelJob(String(id), "cancelled by job_cancel"); if (result === "not-found") throw new Error(`job not found: ${String(id)}`); if (result === "not-running") throw new Error(`job is not running: ${String(id)}`); return { ok: true, job_id: id, status: "cancelled" } } }), { job_id: { type: "string" } }, ["job_id"], { runtimeKinds: ["main"] }),
  ]
}
function auxiliaryTools(subagents?: SubagentService, jobs?: JobsService, channel?: AgentChannelService, search?: WebSearchService): ToolContribution[] {
  const tools: ToolContribution[] = []
  if (subagents) tools.push(contribution("subagent", "Spawn a named configured subagent to handle a task.", async (input, context) => { const name = String(input.name ?? "").trim(); const task = String(input.task ?? "").trim(); if (!name || !task) throw new Error("subagent requires a name and task"); const subagent = subagents.findSubagent(name); if (!subagent) throw new Error(`no subagent named \"${name}\"`); if (input.blocking) return subagents.runSubagent(context.convId, subagent, task, context.signal, kind(context)); if (!jobs) throw new Error("subagent background jobs are unavailable"); const id = jobs.startJob(`subagent:${name}`, signal => subagents.runSubagent(context.convId, subagent, task, signal, kind(context))); return `subagent \"${name}\" started as background job (${id}).` }, { name: { type: "string" }, task: { type: "string" }, blocking: { type: "boolean" } }, ["name", "task"], { runtimeKinds: ["main"] }))
  if (channel) {
    tools.push(contribution("agent_send", "Send a durable message to the other virtual agent and wake it.", (_input, context) => standard(context, { name: "agent_send", logArgKeys: ["content"] as const, runArgKeys: ["content"] as const, run: content => channel.sendAgentChannelMessage(kind(context), content) }), { content: { type: "string", minLength: 1, description: "Message content." } }, ["content"]))
    tools.push(contribution("agent_channel", "Read recent durable messages exchanged between virtual agents.", (_input, context) => standard(context, { name: "agent_channel", logArgKeys: ["limit", "before_id"] as const, runArgKeys: ["limit", "before_id"] as const, run: (limit, before) => channel.listAgentChannelMessages({ limit, beforeId: before }) }), { limit: { type: "integer", minimum: 1, maximum: 100 }, before_id: { type: "string" } }))
  }
  if (search) tools.push(contribution("web_search", "Search the live web.", (_input, context) => standard(context, { name: "web_search", logArgKeys: ["query", "num_results", "include_text"] as const, runArgKeys: ["query", "num_results", "include_text"] as const, run: async (query, count, include) => ({ query, results: await search.webSearch(String(query), count as number | undefined, Boolean(include), context.signal) }) }), { query: { type: "string" }, num_results: { type: "integer", minimum: 1 }, include_text: { type: "boolean" } }, ["query"]))
  return tools
}
function coreTools(persistence?: PersistenceService, discord?: DiscordService): ToolContribution[] {
  return [
    contribution("wait", "Wait for the next incoming message or event.", (_input, context) => { pushToolMessage(context.convId, context.state, context.call, "Waiting for next event."); return { shouldWaitForEvent: true } }),
    contribution("wait_then_continue", "Wait for a short delay, then continue to another assistant turn.", async (input, context) => {
      const event = await context.hooks.waitForEventWithTimeout(normalizeTimeoutMs(input.timeout_ms as number | undefined, 10_000))
      pushToolMessage(context.convId, context.state, context.call, event ? "Wait interrupted by an incoming event." : "Wait completed.")
      if (event) { context.hooks.injectIncomingEvent(context.convId, event); return { isWait: true } }
      return {}
    }, { timeout_ms: { type: "integer", minimum: 0, maximum: 600000 } }),
    contribution("end_session", "End the active session after writing a durable snapshot.", async (input, context) => {
      if (!persistence) throw new Error("session persistence is unavailable")
      const note = typeof input.note === "string" ? input.note : undefined
      pushToolMessage(context.convId, context.state, context.call, "Session ended.")
      if (context.state.modelSwap) {
        if (!context.state.modelSwap.journaled) context.state.modelSwap.fallbackReason = "outgoing session ended without a successful journal edit"
        const rest = persistence.recordRestContextSnapshot(context.state.context.snapshot(), note ?? "model swap handoff", kind(context))
        await persistence.saveRestSnapshot(context.state.context.items, note, kind(context), rest.forest)
        await persistence.clearSession(kind(context))
        context.state.modelSwap.completed = true
        return { shouldRest: true }
      }
      await persistence.saveRestSnapshot(context.state.context.items, note, kind(context))
      try {
        const compacted = await compactForShutdown(context.state)
        if (compacted === "rewritten") await persistence.saveRestSnapshot(context.state.context.items, note, kind(context))
      } catch (error) {
        console.warn(`[runner] end_session compaction failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      await persistence.clearSession(kind(context))
      return { shouldRest: true }
    }, { note: { type: "string" } }),
    ...(discord ? [contribution("voice_reply", "Reply to a pending realtime voice delegation.", (_input, context) => { const result = discord.sendVoiceReply(String(context.args.delegation_id ?? ""), String(context.args.input_text ?? "")); return result.ok ? `sent ${result.chunks} voice chunk(s)` : `voice reply rejected: ${result.error}` }, { delegation_id: { type: "string" }, input_text: { type: "string" } }, ["delegation_id", "input_text"], { availableFor: () => discord.available })] : []),
  ]
}

export const toolFamiliesPlugin: Plugin = {
  id: "nano.tool-families",
  optional: [nano.memory, nano.discord, nano.client, nano.images, nano.persistence, nano.jobs, nano.subagents, nano.agentChannel, nano.webSearch, nano.contextManagement],
  apply(scope) {
    const memory = scope.optional(nano.memory)
    const discord = scope.optional(nano.discord)
    const client = scope.optional(nano.client)
    const persistence = scope.optional(nano.persistence)
    const jobs = scope.optional(nano.jobs)
    const subagents = scope.optional(nano.subagents)
    const channel = scope.optional(nano.agentChannel)
    const webSearch = scope.optional(nano.webSearch)
    const images = scope.optional(nano.images)
    const contextManagement = scope.optional(nano.contextManagement)
    const checkGitUpstream = client && persistence && GIT_UPSTREAM_NAG ? createGitUpstreamChecker(client, persistence) : undefined
    const contributions: ToolContribution[] = [
      ...coreTools(persistence, discord),
      ...(memory ? memoryTools(memory, checkGitUpstream, discord) : []),
      ...(!memory && client ? clientFileTools(client, checkGitUpstream) : []),
      ...(discord ? discordTools(discord) : []),
      ...(client ? clientTools(client, images ?? undefined) : (images ? imageOnlyTools(images) : [])),
      ...(jobs ? jobsTools(jobs) : []),
      ...(subagents || channel || webSearch ? auxiliaryTools(subagents, jobs, channel, webSearch) : []),
      ...(contextManagement ? [
        contribution("lcm_describe", "Inspect a known context summary by id.", (_input, context) => standard(context, { name: "lcm_describe", logArgKeys: ["id", "tokenCap"] as const, runArgKeys: ["id", "tokenCap"] as const, run: (id, cap) => contextManagement.describeContextSummary(String(id), cap as number | undefined, kind(context)) }), { id: { type: "string" }, tokenCap: { type: "integer", minimum: 1 } }, ["id"]),
        contribution("context_grep", "Search immutable prior context messages.", (_input, context) => standard(context, { name: "context_grep", logArgKeys: ["query", "summary_id", "limit"] as const, runArgKeys: ["query", "limit", "summary_id"] as const, run: (query, limit, summaryId) => ({ query, summaryId: summaryId ?? null, results: contextManagement.grepContext(String(query), limit as number | undefined, summaryId as string | undefined, kind(context)) }) }), { query: { type: "string" }, summary_id: { type: "string" }, limit: { type: "integer", minimum: 1 } }, ["query"]),
        contribution("context_expand", "Read a bounded page beneath a context summary id.", (_input, context) => standard(context, { name: "context_expand", logArgKeys: ["summary_id", "offset", "limit"] as const, runArgKeys: ["summary_id", "offset", "limit"] as const, run: (id, offset, limit) => contextManagement.expandContextSummary(String(id), offset as number | undefined, limit as number | undefined, kind(context)) }), { summary_id: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 } }, ["summary_id"]),
      ] : []),
    ]
    const remove = contributions.map(item => registerTool(scope, item.definition.function.name, item))
    return () => { for (const unregister of remove) unregister() }
  },
}
