import fs from "fs/promises"
import path from "path"
import type { Message } from "../types"
import { findSummaryMessageIndex, messageStringContent } from "./messages"

// Store session data in working directory, not install location (Nix store is read-only)
const DATA_DIR = process.cwd()
const REST_SNAPSHOT_FILE = path.join(DATA_DIR, ".coral-rest-snapshot.json")

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
