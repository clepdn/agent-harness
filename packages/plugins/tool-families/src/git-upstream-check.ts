import path from "node:path"
import { AGENT_ID } from "@nano/runtime-api/agent-config"
import type { ClientService, PersistenceService } from "@nano/runtime-api"
import type { LoopState } from "@nano/runtime-api/contracts/runner"

const THROTTLE_MS = 10 * 60 * 1000

type GitResult = { ok: boolean; output: string }
type GitRunner = (directory: string, args: string, timeoutMs: number) => Promise<GitResult>

/**
 * Run git where the files actually are: on the attached client. The repo the
 * agent edits lives in its workspace, which is a different machine whenever
 * the executor is remote.
 */
async function clientGit(directory: string, args: string, timeoutMs: number, client: ClientService, signal: AbortSignal): Promise<GitResult> {
  const target = `'${directory.replace(/'/g, "'\\''")}'`
  const result = await client.execute({
    agentId: AGENT_ID,
    tool: "shell",
    args: { command: `git -C ${target} ${args} 2>&1`, max_lines: 0, timeout_ms: timeoutMs },
    signal,
    timeoutMs: timeoutMs + 5_000,
  })
  return { ok: result.status === "ok", output: (result.output ?? "").trim() }
}

export type RemoteRefCheck = "changed" | "unchanged" | "failed"

/** Fetch and compare remote-tracking refs; fetch output itself is not state. */
export async function fetchRemoteRefChanges(toplevel: string, runGit: GitRunner): Promise<RemoteRefCheck> {
  const snapshotArgs = "for-each-ref --format='%(refname) %(objectname)' refs/remotes"
  const before = await runGit(toplevel, snapshotArgs, 5_000)
  if (!before.ok) return "failed"
  const fetched = await runGit(toplevel, "fetch", 30_000)
  if (!fetched.ok) return "failed"
  const after = await runGit(toplevel, snapshotArgs, 5_000)
  if (!after.ok) return "failed"
  return before.output === after.output ? "unchanged" : "changed"
}

/** Create throttle state scoped to one tool-family plugin generation. */
export function createGitUpstreamChecker(client: ClientService, persistence: PersistenceService) {
  const fetchCache = new Map<string, number>()
  const inFlight = new Set<string>()

  return async (filePath: string, convId: number, state: LoopState, signal: AbortSignal): Promise<void> => {
    let toplevel: string
    try {
      const result = await clientGit(path.dirname(filePath), "rev-parse --show-toplevel", 5_000, client, signal)
      if (!result.ok) return
      toplevel = (result.output.split("\n")[0] ?? "").trim()
      if (!toplevel.startsWith("/")) return
    } catch {
      return
    }
    const now = Date.now()
    const lastCheck = fetchCache.get(toplevel)
    if (lastCheck && now - lastCheck < THROTTLE_MS) return
    if (inFlight.has(toplevel)) return
    inFlight.add(toplevel)
    try {
      const remoteRefs = await fetchRemoteRefChanges(toplevel, (directory, args, timeoutMs) => clientGit(directory, args, timeoutMs, client, signal))
      if (remoteRefs === "failed") return
      if (remoteRefs === "changed") {
        const nag = `[system] This repo's remote has been updated! (${toplevel})\nRecent changes fetched from upstream. You may need to pull and rebase your local changes to stay in sync.`
        state.context.append({ role: "user", content: nag, timestamp: Date.now() })
        persistence.logMessage(convId, "user", nag)
        console.log(`[git-upstream-nag] upstream changed for ${toplevel}, nagging agent`)
        return
      }
      fetchCache.set(toplevel, Date.now())
    } catch {
      // An optional upstream probe must not fail the file operation.
    } finally {
      inFlight.delete(toplevel)
    }
  }
}
