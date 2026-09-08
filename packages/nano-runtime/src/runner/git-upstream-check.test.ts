import assert from "node:assert/strict"
import test from "node:test"
import { fetchRemoteRefChanges } from "./git-upstream-check"

type GitResult = { ok: boolean; output: string }

function sequencedGit(results: GitResult[]) {
  const calls: Array<{ args: string; timeoutMs: number }> = []
  const runGit = async (_directory: string, args: string, timeoutMs: number): Promise<GitResult> => {
    calls.push({ args, timeoutMs })
    const result = results.shift()
    assert.ok(result, "unexpected git invocation")
    return result
  }
  return { calls, runGit }
}

test("ignores noisy fetch output when remote refs did not change", async () => {
  const refs = "refs/remotes/origin/main 0123456789abcdef"
  const git = sequencedGit([
    { ok: true, output: refs },
    { ok: true, output: "remote: this server prints on every fetch" },
    { ok: true, output: refs },
  ])

  assert.equal(await fetchRemoteRefChanges("/repo", git.runGit), "unchanged")
  assert.deepEqual(git.calls.map(({ args }) => args), [
    "for-each-ref --format='%(refname) %(objectname)' refs/remotes",
    "fetch",
    "for-each-ref --format='%(refname) %(objectname)' refs/remotes",
  ])
})

test("detects a remote ref moved by fetch", async () => {
  const git = sequencedGit([
    { ok: true, output: "refs/remotes/origin/main aaaa" },
    { ok: true, output: "" },
    { ok: true, output: "refs/remotes/origin/main bbbb" },
  ])

  assert.equal(await fetchRemoteRefChanges("/repo", git.runGit), "changed")
})

test("reports a failed fetch instead of treating its output as a change", async () => {
  const git = sequencedGit([
    { ok: true, output: "refs/remotes/origin/main aaaa" },
    { ok: false, output: "remote: unavailable" },
  ])

  assert.equal(await fetchRemoteRefChanges("/repo", git.runGit), "failed")
  assert.equal(git.calls.length, 2)
})
