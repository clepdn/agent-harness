import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type Database from "better-sqlite3"

const TRACKED_STATE_PATHS = ["soul.md", "memories/core.md"] as const

function trackedStatePath(filePath: string, home: string): (typeof TRACKED_STATE_PATHS)[number] | undefined {
  const resolvedPath = path.resolve(filePath)
  return TRACKED_STATE_PATHS.find((relativePath) => path.resolve(home, relativePath) === resolvedPath)
}

export interface StateHistoryService {
  isTrackedStatePath(filePath: string): boolean
  recordStateRevision(filePath: string, source: string): Promise<void>
  snapshotStateRevisions(): Promise<void>
}

export function createStateHistory(database: Database.Database, home: string): StateHistoryService {
  const trackedPath = (filePath: string) => trackedStatePath(filePath, home)
  const recordStateRevision = async (filePath: string, source: string): Promise<void> => {
    const relativePath = trackedPath(filePath)
    if (relativePath === undefined) return
    let content: string | null
    try {
      content = await fs.readFile(path.resolve(filePath), "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      content = null
    }
    const contentHash = content === null ? null : createHash("sha1").update(content).digest("hex")
    database.transaction(() => {
      const latest = database.prepare("select content_hash from state_revisions where path = ? order by id desc limit 1")
        .get(relativePath) as { content_hash: string | null } | undefined
      if (latest ? latest.content_hash === contentHash : contentHash === null) return
      database.prepare("insert into state_revisions (path, content_hash, content, source) values (?, ?, ?, ?)")
        .run(relativePath, contentHash, content, source)
    })()
  }
  return {
    isTrackedStatePath: (filePath) => trackedPath(filePath) !== undefined,
    recordStateRevision,
    async snapshotStateRevisions() {
      for (const relativePath of TRACKED_STATE_PATHS) await recordStateRevision(path.resolve(home, relativePath), "external")
    },
  }
}

export function isTrackedStatePath(filePath: string, home: string): boolean {
  return trackedStatePath(filePath, home) !== undefined
}
