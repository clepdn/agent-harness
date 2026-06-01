import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import type { Message } from "../types"
import { findSummaryMessageIndex, messageStringContent, sanitizeMessages } from "./messages"

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..")
const SESSION_FILE = path.join(PROJECT_ROOT, "session.json")
const REST_SNAPSHOT_FILE = path.join(PROJECT_ROOT, "rest-snapshot.json")

// ── Session persistence ───────────────────────────────────────────────────────

type SessionData = { systemPrompt: string; messages: Message[] }

export async function saveSession(systemPrompt: string, messages: Message[]): Promise<void> {
  const data: SessionData = { systemPrompt, messages }
  await fs.writeFile(SESSION_FILE, JSON.stringify(data), { encoding: "utf-8", mode: 0o666 })
}

export async function clearSession(): Promise<void> {
  await fs.unlink(SESSION_FILE).catch(() => {})
}

export async function loadSession(): Promise<SessionData | null> {
  try {
    const raw = await fs.readFile(SESSION_FILE, "utf-8")
    const parsed = JSON.parse(raw) as unknown
    // Validate shape — reject old OAI-format sessions (plain arrays)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const data = parsed as Record<string, unknown>
    if (!Array.isArray(data.messages)) return null
    const messages = sanitizeMessages(data.messages as Message[])
    const systemPrompt = typeof data.systemPrompt === "string" ? data.systemPrompt : ""
    console.log(`[runner] found saved session (${messages.length} messages)`)
    return { systemPrompt, messages }
  } catch {
    return null
  }
}

// ── Rest snapshot ─────────────────────────────────────────────────────────────

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
