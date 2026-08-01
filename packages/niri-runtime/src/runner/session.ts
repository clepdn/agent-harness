import fs from "fs/promises"
import path from "path"
import type { Message } from "../types"
import { NIRI_HOME } from "../agent-config"
import { findSummaryMessageIndex, messageStringContent } from "./messages"

// Session state belongs to the agent's durable home, never the executable or
// source directory (which may be an immutable Nix store path).
const DATA_DIR = NIRI_HOME
const REST_SNAPSHOT_FILE = path.join(DATA_DIR, ".coral-rest-snapshot.json")
const SESSION_FILE = path.join(DATA_DIR, "session.json")

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
  await ensureDataDir()
  await fs.writeFile(REST_SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), { encoding: "utf-8", mode: 0o666 })
}

export async function consumeRestSnapshot(): Promise<RestSnapshot | null> {
  try {
    const raw = await fs.readFile(REST_SNAPSHOT_FILE, "utf-8")
    const parsed = JSON.parse(raw) as RestSnapshot
    await fs.unlink(REST_SNAPSHOT_FILE).catch(() => {})
    if (!parsed || typeof parsed.restedAt !== "string" || typeof parsed.summary !== "string") return null
    return parsed
  } catch {
    return null
  }
}

export async function loadRestSnapshot(): Promise<RestSnapshot | null> {
  try {
    const raw = await fs.readFile(REST_SNAPSHOT_FILE, "utf-8")
    const parsed = JSON.parse(raw) as RestSnapshot
    if (!parsed || typeof parsed.restedAt !== "string" || typeof parsed.summary !== "string") return null
    return parsed
  } catch {
    return null
  }
}

// ── Session persistence ───────────────────────────────────────────────────────

export async function saveSession(messages: Message[]): Promise<void> {
  await ensureDataDir()
  await fs.writeFile(SESSION_FILE, JSON.stringify(messages), { encoding: "utf-8", mode: 0o666 })
}

export async function loadSession(): Promise<Message[] | null> {
  try {
    const raw = await fs.readFile(SESSION_FILE, "utf-8")
    const msgs = JSON.parse(raw) as Message[]
    console.log(`[runner] found saved session (${msgs.length} messages)`)
    return msgs
  } catch {
    return null
  }
}

export async function clearSession(): Promise<void> {
  await fs.unlink(SESSION_FILE).catch(() => {})
}
