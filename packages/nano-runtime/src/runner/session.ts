import { createHash } from "node:crypto"
import fs from "fs/promises"
import path from "path"
import type { DiscordMessageTarget, Message } from "../types"
import type { ContextForkReason } from "../llm"
import { NANO_HOME } from "../agent-config"
import { atomicWriteFile, isMissingFileError, quarantineFile } from "../durable-file"
import type { ToolDefinition } from "@nano/harness-core"
import { findSummaryMessageIndex, messageStringContent } from "./messages"
import type { RuntimeKind } from "./types"

// Session state belongs to the agent's durable home, never the executable or
// source directory (which may be an immutable Nix store path).
const DATA_DIR = NANO_HOME
const MEMORY_DIR = path.join(DATA_DIR, "memories")

function persistencePaths(kind: RuntimeKind = "main") {
  const prefix = kind === "frontend" ? "frontend-" : ""
  const sessionFile = path.join(DATA_DIR, `${prefix}session.json`)
  return {
    restSnapshotFile: path.join(DATA_DIR, `.nano-${prefix}rest-snapshot.json`),
    sessionFile,
    sessionBackupFile: `${sessionFile}.bak`,
    discardedPrefix: kind === "frontend" ? "frontend-discarded" : "discarded",
  }
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 })
}

// ── Rest snapshot ─────────────────────────────────────────────────────────────

type RestSnapshot = {
  restedAt: string
  note?: string
  summary: string
}

export function restSummaryFromMessages(messages: readonly Message[]): string {
  const summaryIndex = findSummaryMessageIndex(messages)
  return summaryIndex >= 0 ? messageStringContent(messages[summaryIndex]!) : "(no llm context summary yet)"
}

export async function saveRestSnapshot(messages: readonly Message[], note?: string, kind: RuntimeKind = "main"): Promise<void> {
  const trimmedNote = typeof note === "string" ? note.trim() : ""
  const snapshot: RestSnapshot = {
    restedAt: new Date().toISOString(),
    ...(trimmedNote ? { note: trimmedNote } : {}),
    summary: restSummaryFromMessages(messages),
  }
  await atomicWriteFile(persistencePaths(kind).restSnapshotFile, JSON.stringify(snapshot, null, 2))
}

function validRestSnapshot(value: unknown): value is RestSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<RestSnapshot>
  return typeof candidate.restedAt === "string" && Number.isFinite(Date.parse(candidate.restedAt)) &&
    typeof candidate.summary === "string" && (candidate.note === undefined || typeof candidate.note === "string")
}

async function readRestSnapshot(consume: boolean, kind: RuntimeKind): Promise<RestSnapshot | null> {
  const { restSnapshotFile } = persistencePaths(kind)
  let raw: string
  try {
    raw = await fs.readFile(restSnapshotFile, "utf-8")
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
    if (!validRestSnapshot(parsed)) throw new Error("invalid rest snapshot shape")
  } catch (error) {
    const quarantined = await quarantineFile(restSnapshotFile)
    if (quarantined) console.warn(`[runner] quarantined invalid rest snapshot at ${quarantined}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  if (consume) await fs.unlink(restSnapshotFile)
  return parsed as RestSnapshot
}

export async function consumeRestSnapshot(kind: RuntimeKind = "main"): Promise<RestSnapshot | null> {
  return readRestSnapshot(true, kind)
}

export async function loadRestSnapshot(kind: RuntimeKind = "main"): Promise<RestSnapshot | null> {
  return readRestSnapshot(false, kind)
}

// ── Session persistence ───────────────────────────────────────────────────────

export const SESSION_SNAPSHOT_VERSION = 1 as const
const CONTEXT_FORK_REASONS = new Set<ContextForkReason>([
  "fork",
  "edit",
  "truncate",
  "compaction",
  "sanitize",
  "image-scrub",
  "model-change",
  "tools-change",
  "settings-change",
  "restore",
  "reset",
])

export type SessionSnapshot = {
  version: typeof SESSION_SNAPSHOT_VERSION
  messages: Message[]
  toolCatalog: ToolDefinition[]
  toolCatalogEpoch: number
  toolCatalogFingerprint: string
  contextId?: string
  parentContextId?: string
  contextForkReason?: ContextForkReason
  contextConfigurationFingerprint?: string
  contextModelId?: string
  discordTargets?: DiscordMessageTarget[]
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function validDiscordTarget(value: unknown): value is DiscordMessageTarget {
  const target = record(value)
  return Boolean(target) && Number.isSafeInteger(target!.position) && (target!.position as number) >= 1 &&
    (target!.friendlyId === undefined || typeof target!.friendlyId === "string") &&
    typeof target!.channelId === "string" && target!.channelId.length > 0 &&
    typeof target!.messageId === "string" && target!.messageId.length > 0 &&
    (target!.itemId === undefined || typeof target!.itemId === "string") &&
    typeof target!.content === "string" &&
    (target!.createdAt === undefined || typeof target!.createdAt === "string")
}

const USER_CONTENT_TYPES = new Set(["text", "image"])
const ASSISTANT_CONTENT_TYPES = new Set(["text", "thinking", "toolCall"])
const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"])

function validContentPart(value: unknown, allowed: ReadonlySet<string>): boolean {
  const part = record(value)
  if (!part || typeof part.type !== "string" || !allowed.has(part.type)) return false
  if (part.type === "text") return typeof part.text === "string"
  if (part.type === "thinking") return typeof part.thinking === "string"
  if (part.type === "image") return typeof part.data === "string" && typeof part.mimeType === "string"
  return typeof part.id === "string" && part.id.length > 0 && typeof part.name === "string" && part.name.length > 0 && record(part.arguments) !== null
}

function validMessage(value: unknown): value is Message {
  const message = record(value)
  if (!message || !finiteNumber(message.timestamp)) return false
  if (message.imageReferences !== undefined && (!Array.isArray(message.imageReferences) || !message.imageReferences.every((value) => {
    const ref = record(value)
    return ref && typeof ref.label === "string" && (ref.kind === "markdown" ? typeof ref.path === "string"
      : ref.kind === "discord-emoji" ? typeof ref.emojiId === "string" && typeof ref.name === "string" && typeof ref.animated === "boolean"
      : ref.kind === "discord-avatar" && typeof ref.userId === "string" &&
        (ref.avatar === undefined || ref.avatar === null || typeof ref.avatar === "string") &&
        (ref.discriminator === undefined || typeof ref.discriminator === "string") &&
        (ref.own === undefined || typeof ref.own === "boolean"))
  }))) return false
  if (message.imageAttachments !== undefined && (!Array.isArray(message.imageAttachments) || !message.imageAttachments.every((value) => {
    const image = record(value)
    return image?.type === "image" && typeof image.data === "string" && typeof image.mimeType === "string" && typeof image.key === "string" && typeof image.label === "string"
  }))) return false
  if (message.imageNotes !== undefined && (!Array.isArray(message.imageNotes) || !message.imageNotes.every((note) => typeof note === "string"))) return false
  if (message.imagesSuppressed !== undefined && typeof message.imagesSuppressed !== "boolean") return false
  if (message.role === "user") {
    return typeof message.content === "string" ||
      (Array.isArray(message.content) && message.content.every((part) => validContentPart(part, USER_CONTENT_TYPES)))
  }
  if (message.role === "assistant") {
    const usage = record(message.usage)
    const cost = usage && record(usage.cost)
    return Array.isArray(message.content) &&
      message.content.every((part) => validContentPart(part, ASSISTANT_CONTENT_TYPES)) &&
      typeof message.api === "string" && typeof message.provider === "string" && typeof message.model === "string" &&
      typeof message.stopReason === "string" && STOP_REASONS.has(message.stopReason) && Boolean(usage) && Boolean(cost) &&
      [usage!.input, usage!.output, usage!.cacheRead, usage!.cacheWrite, usage!.totalTokens,
        cost!.input, cost!.output, cost!.cacheRead, cost!.cacheWrite, cost!.total].every(finiteNumber)
  }
  if (message.role === "toolResult") {
    return typeof message.toolCallId === "string" && message.toolCallId.length > 0 &&
      typeof message.toolName === "string" && message.toolName.length > 0 && typeof message.isError === "boolean" &&
      Array.isArray(message.content) && message.content.every((part) => validContentPart(part, USER_CONTENT_TYPES))
  }
  return false
}

function validToolDefinition(value: unknown): value is ToolDefinition {
  const tool = record(value)
  const fn = tool && record(tool.function)
  return tool?.type === "function" && Boolean(fn) && typeof fn!.name === "string" && fn!.name.length > 0 &&
    typeof fn!.description === "string" && record(fn!.parameters) !== null
}

function fingerprint(catalog: ToolDefinition[]): string {
  return createHash("sha256").update(JSON.stringify(catalog)).digest("hex")
}

function parseSession(raw: string): SessionSnapshot {
  const parsed: unknown = JSON.parse(raw)
  const candidate = record(parsed)
  if (!candidate || candidate.version !== SESSION_SNAPSHOT_VERSION) throw new Error("unsupported session snapshot version")
  if (!Array.isArray(candidate.messages) || !candidate.messages.every(validMessage)) throw new Error("invalid session messages")
  if (!Array.isArray(candidate.toolCatalog) || !candidate.toolCatalog.every(validToolDefinition)) throw new Error("invalid session tool catalog")
  if (candidate.discordTargets !== undefined &&
      (!Array.isArray(candidate.discordTargets) || !candidate.discordTargets.every(validDiscordTarget))) {
    throw new Error("invalid session Discord targets")
  }
  if (!Number.isInteger(candidate.toolCatalogEpoch) || (candidate.toolCatalogEpoch as number) < 1) throw new Error("invalid session tool catalog epoch")
  if (typeof candidate.toolCatalogFingerprint !== "string" || candidate.toolCatalogFingerprint !== fingerprint(candidate.toolCatalog)) {
    throw new Error("invalid session tool catalog fingerprint")
  }
  if (candidate.contextId !== undefined && typeof candidate.contextId !== "string") throw new Error("invalid context id")
  if (candidate.parentContextId !== undefined && typeof candidate.parentContextId !== "string") throw new Error("invalid parent context id")
  if (candidate.contextForkReason !== undefined &&
      (typeof candidate.contextForkReason !== "string" || !CONTEXT_FORK_REASONS.has(candidate.contextForkReason as ContextForkReason))) {
    throw new Error("invalid context fork reason")
  }
  if (candidate.contextConfigurationFingerprint !== undefined && typeof candidate.contextConfigurationFingerprint !== "string") {
    throw new Error("invalid context configuration fingerprint")
  }
  if (candidate.contextModelId !== undefined && typeof candidate.contextModelId !== "string") throw new Error("invalid context model id")
  return candidate as unknown as SessionSnapshot
}

async function readSessionFile(filePath: string): Promise<{ raw: string; snapshot: SessionSnapshot } | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf-8")
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
  try {
    return { raw, snapshot: parseSession(raw) }
  } catch (error) {
    const quarantined = await quarantineFile(filePath)
    console.warn(`[runner] rejected invalid session ${filePath}: ${error instanceof Error ? error.message : String(error)}${quarantined ? `; quarantined at ${quarantined}` : ""}`)
    return null
  }
}

/** Persist the active conversation together with its pinned tool catalog epoch. */
export async function saveSession(snapshot: SessionSnapshot, kind: RuntimeKind = "main"): Promise<void> {
  const { sessionFile, sessionBackupFile } = persistencePaths(kind)
  const raw = JSON.stringify(snapshot)
  parseSession(raw)
  await ensureDataDir()
  const current = await readSessionFile(sessionFile)
  if (current) await atomicWriteFile(sessionBackupFile, current.raw)
  await atomicWriteFile(sessionFile, raw)
}

/** Load a valid pinned session; legacy message arrays intentionally do not resume. */
export async function loadSession(kind: RuntimeKind = "main"): Promise<SessionSnapshot | null> {
  const { sessionFile, sessionBackupFile } = persistencePaths(kind)
  const primary = await readSessionFile(sessionFile)
  if (primary) {
    console.log(`[runner] found saved session (${primary.snapshot.messages.length} messages, catalog epoch ${primary.snapshot.toolCatalogEpoch})`)
    return primary.snapshot
  }
  const backup = await readSessionFile(sessionBackupFile)
  if (!backup) return null
  await atomicWriteFile(sessionFile, backup.raw)
  console.warn(`[runner] restored session from last-known-good backup (${backup.snapshot.messages.length} messages)`)
  return backup.snapshot
}

export async function clearSession(kind: RuntimeKind = "main"): Promise<void> {
  const { sessionFile, sessionBackupFile } = persistencePaths(kind)
  const unlinkIfPresent = async (filePath: string): Promise<void> => {
    try {
      await fs.unlink(filePath)
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
  }
  await Promise.all([unlinkIfPresent(sessionFile), unlinkIfPresent(sessionBackupFile)])
}

/**
 * Archive the latest in-memory session where the model can inspect it, then
 * remove both resumable checkpoints so it cannot be resumed accidentally.
 */
export async function archiveDiscardedSession(snapshot: SessionSnapshot, kind: RuntimeKind = "main"): Promise<string> {
  const raw = JSON.stringify(snapshot, null, 2)
  parseSession(raw)
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const filename = `${persistencePaths(kind).discardedPrefix}-${timestamp}.json`
  await atomicWriteFile(path.join(MEMORY_DIR, filename), raw)
  await clearSession(kind)
  return `memory://${filename}`
}

/** Remove all resumable full-session checkpoints after an unrecoverable loop abort. */
export async function quarantineSession(kind: RuntimeKind = "main"): Promise<string[]> {
  const { sessionFile, sessionBackupFile } = persistencePaths(kind)
  const quarantined: string[] = []
  for (const filePath of [sessionFile, sessionBackupFile]) {
    const moved = await quarantineFile(filePath)
    if (moved) quarantined.push(moved)
  }
  return quarantined
}
