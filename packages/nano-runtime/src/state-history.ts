import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { NANO_HOME } from "./agent-config"
import { getDb, isDbInitialized } from "./db"

const TRACKED_STATE_PATHS = ["soul.md", "memories/core.md"] as const

function trackedStatePath(filePath: string): (typeof TRACKED_STATE_PATHS)[number] | undefined {
  const resolvedPath = path.resolve(filePath)
  return TRACKED_STATE_PATHS.find((relativePath) => path.resolve(NANO_HOME, relativePath) === resolvedPath)
}

export function isTrackedStatePath(filePath: string): boolean {
  return trackedStatePath(filePath) !== undefined
}

export async function recordStateRevision(filePath: string, source: string): Promise<void> {
  if (!isDbInitialized()) return
  const relativePath = trackedStatePath(filePath)
  if (relativePath === undefined) return

  let content: string | null
  try {
    content = await fs.readFile(path.resolve(filePath), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    content = null
  }
  const contentHash = content === null ? null : createHash("sha1").update(content).digest("hex")
  const db = getDb()
  db.transaction(() => {
    const latest = db.prepare(
      "select content_hash from state_revisions where path = ? order by id desc limit 1",
    ).get(relativePath) as { content_hash: string | null } | undefined
    if (latest ? latest.content_hash === contentHash : contentHash === null) return

    db.prepare(
      "insert into state_revisions (path, content_hash, content, source) values (?, ?, ?, ?)",
    ).run(relativePath, contentHash, content, source)
  })()
}

export async function snapshotStateRevisions(): Promise<void> {
  for (const relativePath of TRACKED_STATE_PATHS) {
    await recordStateRevision(path.resolve(NANO_HOME, relativePath), "external")
  }
}
