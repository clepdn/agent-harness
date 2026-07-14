import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { cleanOutput } from "./shell"
import { runCommand } from "./tools"

test("shell disables git pager and terminal prompts", async () => {
  const output = await runCommand(
    "printf '%s\\n%s\\n%s\\n%s' \"$GIT_PAGER\" \"$GIT_TERMINAL_PROMPT\" \"$PAGER\" \"$LESS\"",
    0,
    5_000,
  )

  assert.equal(output, "cat\n0\ncat\nFRX")
})

test("shell handles stty echo without corrupting output", async () => {
  // With one-shot sessions, `stty echo` in one command cannot affect the next.
  assert.equal(await runCommand("stty echo; echo first", 0, 5_000), "first")
})

test("cleanOutput collapses terminal redraw controls", () => {
  assert.equal(cleanOutput("one\rspinner\rdone\n"), "done\n")
  assert.equal(cleanOutput("abc\b \bd\n"), "abd\n")
  assert.equal(cleanOutput("\x1b[?25lhidden\x1b[?25h\n"), "hidden\n")
})

test("cd in one command does not affect the next", async () => {
  const { currentWorkingDirectory } = await import("./shell")
  const root = (await currentWorkingDirectory()).trim()
  await runCommand("cd /tmp && pwd", 0, 5_000)
  // The next command still starts from root.
  const out = await runCommand("pwd", 0, 5_000)
  assert.equal(out.trim(), root)
})

test("sudo commands run as one-off commands with stdin closed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "niri-fake-sudo-"))
  const fakeSudo = path.join(dir, "sudo")
  await fs.writeFile(
    fakeSudo,
    [
      "#!/bin/sh",
      "if [ -t 0 ]; then",
      "  echo stdin_tty",
      "else",
      "  echo stdin_not_tty",
      "fi",
      'exec "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  )

  const oldPath = process.env.PATH
  process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ""}`
  try {
    const output = await runCommand("echo before; sudo printf ok; echo after", 0, 5_000)

    assert.equal(output, "before\nstdin_not_tty\nokafter")
  } finally {
    if (oldPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = oldPath
    }
    await fs.rm(dir, { recursive: true, force: true })
  }
})
