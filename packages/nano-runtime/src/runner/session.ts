import { createHash } from "node:crypto"
import fs from "fs/promises"
import path from "path"
import type { Message } from "../types"
import { NANO_HOME } from "../agent-config"
import { atomicWriteFile, isMissingFileError, quarantineFile } from "../durable-file"
import type { ToolDefinition } from "@nano/harness-core"
import { findSummaryMessageIndex, messageStringContent } from "./messages"

// Session state belongs to the agent's durable home, never the executable or
// source directory (which may be an immutable Nix store path).
const DATA_DIR = NANO_HOME
const REST_SNAPSHOT_FILE = path.join(DATA_DIR, ".nano-rest-snapshot.json")
const SESSION_FILE = path.join(DATA_DIR, "session.json")
const SESSION_BACKUP_FILE = path.join(DATA_DIR, "session.json.bak")

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 })
}

// ── Rest snapshot ─────────────────────────────────────────────────────────────

type RestSnapshot = {
  restedAt: string
  note?: string
  summary: string
}

export function restSummaryFromMessages(messages: Message[]): string {
  const summaryIndex = findSummaryMessageIndex(messages)
  return summaryIndex >= 0 ? messageStringContent(messages[summaryIndex]!) : "(no llm context summary yet)"
}

export async function saveRestSnapshot(messages: Message[], note?: string): Promise<void> {
  const trimmedNote = typeof note === "string" ? note.trim() : ""
  const snapshot: RestSnapshot = {
    restedAt: new Date().toISOString(),
    ...(trimmedNote ? { note: trimmedNote } : {}),
    summary: restSummaryFromMessages(messages),
  }
  await atomicWriteFile(REST_SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2))
}

function validRestSnapshot(value: unknown): value is RestSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<RestSnapshot>
  return typeof candidate.restedAt === "string" && Number.isFinite(Date.parse(candidate.restedAt)) &&
    typeof candidate.summary === "string" && (candidate.note === undefined || typeof candidate.note === "string")
}

async function readRestSnapshot(consume: boolean): Promise<RestSnapshot | null> {
  let raw: string
  try {
    raw = await fs.readFile(REST_SNAPSHOT_FILE, "utf-8")
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
    if (!validRestSnapshot(parsed)) throw new Error("invalid rest snapshot shape")
  } catch (error) {
    const quarantined = await quarantineFile(REST_SNAPSHOT_FILE)
    if (quarantined) console.warn(`[runner] quarantined invalid rest snapshot at ${quarantined}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  if (consume) await fs.unlink(REST_SNAPSHOT_FILE)
  return parsed as RestSnapshot
}

export async function consumeRestSnapshot(): Promise<RestSnapshot | null> {
  return readRestSnapshot(true)
}

export async function loadRestSnapshot(): Promise<RestSnapshot | null> {
  return readRestSnapshot(false)
}

// ── Session persistence ───────────────────────────────────────────────────────

export const SESSION_SNAPSHOT_VERSION = 1 as const

export type SessionSnapshot = {
  version: typeof SESSION_SNAPSHOT_VERSION
  messages: Message[]
  toolCatalog: ToolDefinition[]
  toolCatalogEpoch: number
  toolCatalogFingerprint: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
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
  if (!Number.isInteger(candidate.toolCatalogEpoch) || (candidate.toolCatalogEpoch as number) < 1) throw new Error("invalid session tool catalog epoch")
  if (typeof candidate.toolCatalogFingerprint !== "string" || candidate.toolCatalogFingerprint !== fingerprint(candidate.toolCatalog)) {
    throw new Error("invalid session tool catalog fingerprint")
  }
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
export async function saveSession(snapshot: SessionSnapshot): Promise<void> {
  const raw = JSON.stringify(snapshot)
  parseSession(raw)
  await ensureDataDir()
  const current = await readSessionFile(SESSION_FILE)
  if (current) await atomicWriteFile(SESSION_BACKUP_FILE, current.raw)
  await atomicWriteFile(SESSION_FILE, raw)
}

/** Load a valid pinned session; legacy message arrays intentionally do not resume. */
export async function loadSession(): Promise<SessionSnapshot | null> {
  const primary = await readSessionFile(SESSION_FILE)
  if (primary) {
    console.log(`[runner] found saved session (${primary.snapshot.messages.length} messages, catalog epoch ${primary.snapshot.toolCatalogEpoch})`)
    return primary.snapshot
  }
  const backup = await readSessionFile(SESSION_BACKUP_FILE)
  if (!backup) return null
  await atomicWriteFile(SESSION_FILE, backup.raw)
  console.warn(`[runner] restored session from last-known-good backup (${backup.snapshot.messages.length} messages)`)
  return backup.snapshot
}

export async function clearSession(): Promise<void> {
  const unlinkIfPresent = async (filePath: string): Promise<void> => {
    try {
      await fs.unlink(filePath)
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
  }
  await Promise.all([unlinkIfPresent(SESSION_FILE), unlinkIfPresent(SESSION_BACKUP_FILE)])
}

/** Remove all resumable full-session checkpoints after an unrecoverable loop abort. */
export async function quarantineSession(): Promise<string[]> {
  const quarantined: string[] = []
  for (const filePath of [SESSION_FILE, SESSION_BACKUP_FILE]) {
    const moved = await quarantineFile(filePath)
    if (moved) quarantined.push(moved)
  }
  return quarantined
}
