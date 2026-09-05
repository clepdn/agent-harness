import assert from "node:assert/strict"
import test from "node:test"
import { configureNodeToolRuntime } from "./config.js"
import { cleanOutput } from "./shell.js"
import { runCommand } from "./tools.js"

test.afterEach(() => {
  configureNodeToolRuntime({ workspaceRoot: process.cwd() })
})

test("shell disables git pager and terminal prompts", async () => {
  const output = await runCommand(
    "printf '%s\\n%s\\n%s\\n%s' \"$GIT_PAGER\" \"$GIT_TERMINAL_PROMPT\" \"$PAGER\" \"$LESS\"",
    0,
    5_000,
  )
  assert.equal(output, "cat\n0\ncat\nFRX")
})

test("every command starts in a fresh shell at the workspace root", async () => {
  const workspace = process.cwd()
  await runCommand("cd /; export SHOULD_NOT_LEAK=yes", 0, 5_000)
  const output = await runCommand("printf '%s\\n%s' \"$PWD\" \"${SHOULD_NOT_LEAK-}\"", 0, 5_000)
  assert.equal(output, workspace)
})

test("concurrent commands use isolated processes", async () => {
  const [first, second] = await Promise.all([
    runCommand("sleep 0.05; printf first", 0, 5_000),
    runCommand("printf second", 0, 5_000),
  ])
  assert.equal(first, "first")
  assert.equal(second, "second")
})

test("PTY allocation is explicit and per command", async () => {
  const plain = await runCommand("if [ -t 1 ]; then printf tty; else printf pipe; fi", 0, 5_000)
  const terminal = await runCommand("if [ -t 1 ]; then printf tty; else printf pipe; fi", 0, 5_000, true)
  assert.equal(plain, "pipe")
  assert.equal(terminal, "tty")
})

test("non-zero exits reject and preserve diagnostic output", async () => {
  await assert.rejects(
    runCommand("printf 'bad news' >&2; exit 23", 0, 5_000),
    /exited with code 23[\s\S]*bad news/,
  )
})

test("timeouts terminate the isolated command", async () => {
  const startedAt = Date.now()
  await assert.rejects(runCommand("sleep 10", 0, 50), /timed out after 50ms/)
  assert.ok(Date.now() - startedAt < 2_000)
})

test("abort signals terminate the isolated command", async () => {
  const controller = new AbortController()
  const running = runCommand("sleep 10", 0, 5_000, false, controller.signal)
  controller.abort(new Error("test abort"))
  await assert.rejects(running, /cancelled \(test abort\)/)
})

test("commands without trailing newlines preserve output", async () => {
  assert.equal(await runCommand("printf 'bare-output'", 0, 5_000), "bare-output")
  assert.equal(await runCommand("printf '%s' '12 34'", 0, 5_000), "12 34")
})

test("cleanOutput collapses terminal redraw controls", () => {
  assert.equal(cleanOutput("one\rspinner\rdone\n"), "done\n")
  assert.equal(cleanOutput("abc\b \bd\n"), "abd\n")
  assert.equal(cleanOutput("\x1b[?25lhidden\x1b[?25h\n"), "hidden\n")
})

test("runCommand truncates excessively long lines", async () => {
  const output = await runCommand("head -c 2010 /dev/zero | tr '\\0' a", undefined, 5_000)
  assert.equal(output.length, 2000 + " ... [truncated line of 2010 characters]".length)
  assert.ok(output.endsWith(" ... [truncated line of 2010 characters]"))
})

test("shell capture aborts before unbounded output can exhaust memory", async () => {
  configureNodeToolRuntime({ workspaceRoot: process.cwd(), maxResultBytes: 1_000 })
  await assert.rejects(
    runCommand("head -c 1100000 /dev/zero | tr '\\0' x", 0, 10_000),
    /output exceeded 1000000 bytes/,
  )
})
