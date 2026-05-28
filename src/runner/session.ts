import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import type { Message } from "../types"
import { findSummaryMessageIndex, messageStringContent, sanitizeMessages } from "./messages"

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..")
const SESSION_FILE = path.join(PROJECT_ROOT, "session.json")
const REST_SNAPSHOT_FILE = path.join(PROJECT_ROOT, "rest-snapshot.json")

// ── Session persistence ───────────────────────────────────────────────────────

export async function saveSession(messages: Message[]): Promise<void> {
  await fs.writeFile(SESSION_FILE, JSON.stringify(messages), { encoding: "utf-8", mode: 0o666 })
}

export async function clearSession(): Promise<void> {
  await fs.unlink(SESSION_FILE).catch(() => {})
}

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
