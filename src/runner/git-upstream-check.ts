import { execFile } from "node:child_process"
import path from "node:path"
import { logMessage } from "../db"
import type { LoopState } from "./types"

/** Throttle: toplevel → last check timestamp (ms). */
const fetchCache = new Map<string, number>()
const THROTTLE_MS = 10 * 60 * 1000 // 10 minutes

/** In-flight checks: toplevel → boolean (prevents concurrent fetches for same repo). */
const inFlight = new Set<string>()

function execFileAsync(file: string, args: string[], opts: { timeout: number }): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  return new Promise((resolve) => {
    execFile(file, args, { ...opts, encoding: "utf-8" }, (err, stdout, stderr) => {
      resolve({ stdout, stderr, ok: !err })
    })
  })
}

/**
 * On file read/write, checks if the file's git repo has upstream changes.
 * If so, injects a nag message into the conversation.
 * Throttled to once per 10 minutes per repo.
 *
 * Non-blocking: returns immediately, runs git fetch asynchronously.
 * The nag is pushed into the conversation when fetch completes.
 */
export function checkGitUpstream(
  filePath: string,
  convId: number,
  state: LoopState,
): void {
  void (async () => {
    // 1. Find the git toplevel for the file's directory
    let toplevel: string
    try {
      const dir = path.dirname(filePath)
      const { stdout, ok } = await execFileAsync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { timeout: 5000 })
      if (!ok) return // exit 128 — not in a git repo
      toplevel = stdout.trim()
      if (!toplevel) return
    } catch {
      return
    }

    // 2. Check throttle — skip if we've checked this toplevel recently
    const now = Date.now()
    const lastCheck = fetchCache.get(toplevel)
    if (lastCheck && now - lastCheck < THROTTLE_MS) return

    // 3. Don't run concurrent fetches for the same repo
    if (inFlight.has(toplevel)) return
    inFlight.add(toplevel)

    try {
      // 4. Run git fetch
      const { stdout, stderr, ok } = await execFileAsync("git", ["-C", toplevel, "fetch"], { timeout: 30000 })
      if (!ok) return // fetch failed — don't throttle, let it retry

      const output = (stdout + stderr).trim()

      // 5. If fetch output is non-empty, upstream has changed — nag
      if (output) {
        const nag = `[system] This repo's remote has been updated! (${toplevel})\nRecent changes fetched from upstream. You may need to pull and rebase your local changes to stay in sync.`
        state.conversation.push({
          role: "user",
          content: nag,
          timestamp: Date.now(),
        })
        logMessage(convId, "user", nag)
        console.log(`[git-upstream-nag] upstream changed for ${toplevel}, nagging agent`)
        // Don't update the throttle — let the next file op re-check after pulling
        return
      }

      // 6. No changes — update throttle timestamp
      fetchCache.set(toplevel, Date.now())
    } finally {
      inFlight.delete(toplevel)
    }
  })()
}
