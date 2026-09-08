import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { NodeToolHost } from "./host.js"
import type { ClientToolName, ToolInvocation } from "@nano/harness-protocol"

function invocation(tool: ClientToolName, args: Record<string, unknown>): ToolInvocation {
  return {
    type: "tool.call",
    invocationId: `${tool}-1`,
    agentId: "agent",
    tool,
    args,
    issuedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 10_000).toISOString(),
  }
}

test("Docker mode requires both container name and user", () => {
  assert.throws(
    () => new NodeToolHost({ runtime: { containerName: "workspace-container" } }),
    /container name and container user must be configured together/,
  )
})

test("the advertised workspace is the initial directory for each isolated shell", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "harness-host-cwd-"))
  const realWorkspace = await fs.realpath(workspace)
  const host = new NodeToolHost({ capabilities: ["shell"], workspace: { id: "test", root: workspace } })
  try {
    const result = await host.execute(invocation("shell", { command: "pwd -P" }))
    assert.equal(result.status, "ok")
    assert.equal(result.output, realWorkspace)
    assert.equal(host.getWorkspace().root, realWorkspace)
    assert.equal(host.getWorkspace().persistentShell, false)
  } finally {
    await host.stop()
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test("shell failures are returned as tool errors", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "harness-host-shell-error-"))
  const host = new NodeToolHost({ capabilities: ["shell"], workspace: { id: "test", root: workspace } })
  try {
    const result = await host.execute(invocation("shell", { command: "echo nope >&2; exit 7" }))
    assert.equal(result.status, "error")
    assert.match(result.output ?? "", /exited with code 7[\s\S]*nope/)
  } finally {
    await host.stop()
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test("shell PTY allocation is opt-in on each invocation", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "harness-host-shell-pty-"))
  const host = new NodeToolHost({ capabilities: ["shell"], workspace: { id: "test", root: workspace } })
  try {
    const plain = await host.execute(invocation("shell", { command: "if [ -t 1 ]; then echo tty; else echo pipe; fi" }))
    const terminal = await host.execute(invocation("shell", { command: "if [ -t 1 ]; then echo tty; else echo pipe; fi", pty: true }))
    assert.equal(plain.output, "pipe")
    assert.equal(terminal.output, "tty")
  } finally {
    await host.stop()
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test("the invocation deadline cancels and kills a shell command", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "harness-host-shell-deadline-"))
  const host = new NodeToolHost({ capabilities: ["shell"], workspace: { id: "test", root: workspace } })
  try {
    const call = invocation("shell", { command: "sleep 10", timeout_ms: 10_000 })
    call.deadlineAt = new Date(Date.now() + 75).toISOString()
    const startedAt = Date.now()
    const result = await host.execute(call)
    assert.equal(result.status, "cancelled")
    assert.ok(Date.now() - startedAt < 2_000)
  } finally {
    await host.stop()
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test("an unsuccessful exact edit is a tool error", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "harness-host-edit-"))
  const file = path.join(workspace, "notes.md")
  await fs.writeFile(file, "one\n", "utf8")
  const host = new NodeToolHost({ capabilities: ["edit_file"], workspace: { id: "test", root: workspace } })
  try {
    const result = await host.execute(invocation("edit_file", { path: file, old_text: "missing", new_text: "two" }))
    assert.equal(result.status, "error")
    assert.match(result.output ?? "", /old_text not found/)
  } finally {
    await host.stop()
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test("native edits replace atomically and preserve file permissions", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "harness-host-atomic-edit-"))
  const file = path.join(workspace, "notes.md")
  await fs.writeFile(file, "one\n", { mode: 0o640 })
  const host = new NodeToolHost({ capabilities: ["edit_file"], workspace: { root: workspace } })
  try {
    const result = await host.execute(invocation("edit_file", { path: file, old_text: "one", new_text: "two" }))
    assert.equal(result.status, "ok")
    assert.equal(await fs.readFile(file, "utf8"), "two\n")
    assert.equal((await fs.stat(file)).mode & 0o777, 0o640)
    assert.deepEqual((await fs.readdir(workspace)).filter((name) => name.endsWith(".tmp")), [])
  } finally {
    await host.stop()
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test("hashline reads list directories without file line metadata", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "harness-host-directory-"))
  await fs.writeFile(path.join(workspace, "notes.md"), "one\n", "utf8")
  await fs.mkdir(path.join(workspace, "src"))
  const host = new NodeToolHost({
    capabilities: ["read_file"],
    workspace: { root: workspace },
    hashline: true,
  })
  try {
    const result = await host.execute(invocation("read_file", { path: "." }))
    assert.equal(result.status, "ok")
    assert.equal(result.output, ". is a dir\nnotes.md\nsrc")
  } finally {
    await host.stop()
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test("a second host makes the previous process-global runtime fail closed", async () => {
  const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harness-host-first-"))
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harness-host-second-"))
  await fs.writeFile(path.join(firstRoot, "marker.txt"), "first")
  await fs.writeFile(path.join(secondRoot, "marker.txt"), "second")
  const first = new NodeToolHost({ capabilities: ["read_file"], workspace: { root: firstRoot } })
  const second = new NodeToolHost({ capabilities: ["read_file"], workspace: { root: secondRoot } })
  try {
    const stale = await first.execute(invocation("read_file", { path: "marker.txt" }))
    const current = await second.execute(invocation("read_file", { path: "marker.txt" }))
    assert.equal(stale.status, "error")
    assert.match(stale.output ?? "", /superseded/)
    assert.match(current.output ?? "", /second/)
  } finally {
    await first.stop()
    await second.stop()
    await Promise.all([
      fs.rm(firstRoot, { recursive: true, force: true }),
      fs.rm(secondRoot, { recursive: true, force: true }),
    ])
  }
})

test("the model shell does not inherit harness daemon secrets", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "harness-host-env-"))
  process.env.OPENAI_API_KEY = "model-probe"
  process.env.DISCORD_BOT_TOKEN = "discord-probe"
  const host = new NodeToolHost({ capabilities: ["shell"], workspace: { root: workspace } })
  try {
    const result = await host.execute(invocation("shell", {
      command: "printf '%s|%s' \"${OPENAI_API_KEY-}\" \"${DISCORD_BOT_TOKEN-}\"",
    }))
    assert.equal(result.status, "ok")
    assert.equal(result.output, "|")
  } finally {
    delete process.env.OPENAI_API_KEY
    delete process.env.DISCORD_BOT_TOKEN
    await host.stop()
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test("read_bytes returns a file artifact and refuses to exceed the caller's ceiling", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "harness-host-bytes-"))
  const file = path.join(workspace, "upload.bin")
  await fs.writeFile(file, Buffer.from([0, 1, 2, 3, 4]))
  const host = new NodeToolHost({ capabilities: ["read_bytes"], workspace: { id: "test", root: workspace } })
  try {
    const result = await host.execute(invocation("read_bytes", { path: file }))
    assert.equal(result.status, "ok")
    assert.equal(result.image, undefined)
    assert.equal(result.file?.bytes, 5)
    assert.equal(result.file?.mime, "application/octet-stream")
    assert.equal(Buffer.from(result.file?.dataUrl.split(",")[1] ?? "", "base64").length, 5)

    const capped = await host.execute(invocation("read_bytes", { path: file, max_bytes: 4 }))
    assert.equal(capped.status, "error")
    assert.match(capped.output ?? "", /file too large: 5 bytes \(max 4\)/)
  } finally {
    await host.stop()
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test("a capability the host does not expose is refused, not attempted", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "harness-host-caps-"))
  const host = new NodeToolHost({ capabilities: ["shell"], workspace: { id: "test", root: workspace } })
  try {
    const result = await host.execute(invocation("computer", { action: "screenshot" }))
    assert.equal(result.status, "error")
    assert.match(result.output ?? "", /client does not expose computer/)
  } finally {
    await host.stop()
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test("computer rejects an action it cannot perform before touching the display", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "harness-host-computer-"))
  const host = new NodeToolHost({ capabilities: ["computer"], workspace: { id: "test", root: workspace } })
  try {
    const unknown = await host.execute(invocation("computer", { action: "teleport" }))
    assert.equal(unknown.status, "error")
    assert.match(unknown.output ?? "", /unsupported computer action: teleport/)

    const empty = await host.execute(invocation("computer", { action: "keypress", keys: [] }))
    assert.equal(empty.status, "error")
    assert.match(empty.output ?? "", /keypress requires at least one key/)

    const waited = await host.execute(invocation("computer", { action: "wait", duration: 1 }))
    assert.equal(waited.status, "ok")
    assert.equal(waited.output, "waited 1ms")
  } finally {
    await host.stop()
    await fs.rm(workspace, { recursive: true, force: true })
  }
})
