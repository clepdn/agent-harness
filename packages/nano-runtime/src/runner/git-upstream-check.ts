import path from "node:path"
import { AGENT_ID } from "../agent-config"
import { clientTools } from "../client"
import { logMessage } from "../db"
import type { LoopState } from "./types"

/** Throttle: toplevel → last check timestamp (ms). */
const fetchCache = new Map<string, number>()
const THROTTLE_MS = 10 * 60 * 1000 // 10 minutes

/** In-flight checks: toplevel → boolean (prevents concurrent fetches for same repo). */
const inFlight = new Set<string>()

type GitResult = { ok: boolean; output: string }
type GitRunner = (directory: string, args: string, timeoutMs: number) => Promise<GitResult>

/**
 * Run git where the files actually are: on the attached client. The repo the
 * agent edits lives in its workspace, which is a different machine whenever
 * the executor is remote.
 */
async function clientGit(directory: string, args: string, timeoutMs: number): Promise<GitResult> {
  const target = `'${directory.replace(/'/g, "'\\''")}'`
  const result = await clientTools.execute({
    agentId: AGENT_ID,
    tool: "shell",
    args: { command: `git -C ${target} ${args} 2>&1`, max_lines: 0, timeout_ms: timeoutMs },
    timeoutMs: timeoutMs + 5_000,
  })
  return {
    ok: result.status === "ok",
    output: (result.output ?? "").trim(),
  }
}

export type RemoteRefCheck = "changed" | "unchanged" | "failed"

/** Fetch and compare remote-tracking refs; fetch output itself is not state. */
export async function fetchRemoteRefChanges(
  toplevel: string,
  runGit: GitRunner = clientGit,
): Promise<RemoteRefCheck> {
  const snapshotArgs = "for-each-ref --format='%(refname) %(objectname)' refs/remotes"
  const before = await runGit(toplevel, snapshotArgs, 5_000)
  if (!before.ok) return "failed"

  const fetched = await runGit(toplevel, "fetch", 30_000)
  if (!fetched.ok) return "failed"

  const after = await runGit(toplevel, snapshotArgs, 5_000)
  if (!after.ok) return "failed"

  return before.output === after.output ? "unchanged" : "changed"
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
      const result = await clientGit(dir, "rev-parse --show-toplevel", 5000)
      if (!result.ok) return
      const firstLine = result.output.split("\n")[0] ?? ""
      toplevel = firstLine.trim()
      if (!toplevel.startsWith("/")) return // not in a git repo
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
      // 4. Snapshot remote-tracking refs around the fetch. A remote helper or
      // hook may print on every fetch, so output is not evidence of a change.
      const remoteRefs = await fetchRemoteRefChanges(toplevel)
      if (remoteRefs === "failed") return // don't throttle; let it retry

      // 5. Nag only when fetch actually moved, created, or deleted a remote ref.
      if (remoteRefs === "changed") {
        const nag = `[system] This repo's remote has been updated! (${toplevel})\nRecent changes fetched from upstream. You may need to pull and rebase your local changes to stay in sync.`
        state.context.append({
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
