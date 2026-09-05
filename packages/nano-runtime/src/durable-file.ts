import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

export function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(directory, "r")
    await handle.sync()
  } catch {
    // Directory fsync is unsupported on some platforms. The file itself was
    // still flushed before rename, which is the strongest portable guarantee.
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Write and flush a sibling temp file, then atomically replace the target. */
export async function atomicWriteFile(filePath: string, content: string, mode = 0o600): Promise<void> {
  const directory = path.dirname(filePath)
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(tempPath, "wx", mode)
    await handle.writeFile(content, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(tempPath, filePath)
    await syncDirectory(directory)
  } finally {
    await handle?.close().catch(() => {})
    await fs.unlink(tempPath).catch(() => {})
  }
}

/** Move an unreadable durable file out of the active path for diagnosis. */
export async function quarantineFile(filePath: string): Promise<string | null> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const quarantinePath = `${filePath}.corrupt-${timestamp}-${randomUUID().slice(0, 8)}`
  try {
    await fs.rename(filePath, quarantinePath)
    await syncDirectory(path.dirname(filePath))
    return quarantinePath
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
}
