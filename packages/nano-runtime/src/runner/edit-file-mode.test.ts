import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import test from "node:test"

test("memory read/edit handlers enforce the selected format without changing files on rejection", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-edit-mode-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const url = (relative: string) => new URL(relative, import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    import fs from "node:fs/promises"
    import path from "node:path"
    const { initDb, startConversation } = await import(${JSON.stringify(url("../db.ts"))})
    const { Context } = await import(${JSON.stringify(url("../llm.ts"))})
    const { createNiriToolCatalog } = await import(${JSON.stringify(url("./tool-catalog.ts"))})
    const { buildToolHandlers } = await import(${JSON.stringify(url("./loop-tool-registry.ts"))})
    initDb(":memory:")
    const convId = startConversation("test", new Date().toISOString())
    const handlers = buildToolHandlers()
    const file = path.join(process.env.NANO_HOME, "memories", "note.md")
    await fs.mkdir(path.dirname(file), { recursive: true })
    let id = 0
    for (const hashline of [true, false]) {
      const catalog = createNiriToolCatalog({ workspace: { id: "test", root: "/test", hashline } })
      const state = { context: new Context({}), toolCatalog: catalog }
      const run = async (name, args) => {
        await handlers[name]({ convId, state, args, hooks: {}, call: { type: "toolCall", id: "mode-" + ++id, name, arguments: args } })
        return state.context.items.at(-1).content.map((part) => part.text ?? "").join("")
      }
      await fs.writeFile(file, "# Note\\nfirst\\n")
      const wrong = hashline ? { old_text: "first", new_text: "wrong" } : { edits: [{ op: "append", lines: ["wrong"] }] }
      assert.match(await run("edit_file", { path: "memory://note.md", ...wrong }), /^error: edit_file requires/)
      assert.equal(await fs.readFile(file, "utf8"), "# Note\\nfirst\\n")
      const read = await run("read_file", { path: "memory://note.md" })
      if (hashline) {
        const anchor = read.match(/^(\\d+#[A-Z]+): first$/m)?.[1]
        assert.ok(anchor, read)
        assert.doesNotMatch(await run("edit_file", { path: "memory://note.md", edits: [{ op: "replace", pos: anchor, lines: ["changed"] }] }), /^error:/)
      } else {
        assert.doesNotMatch(read, /^\\d+#[A-Z]+:/m)
        assert.doesNotMatch(await run("edit_file", { path: "memory://note.md", old_text: "first", new_text: "changed" }), /^error:/)
        await fs.writeFile(file, "")
        assert.doesNotMatch(await run("edit_file", { path: "memory://note.md", old_text: "", new_text: "# Note\\nchanged\\n" }), /^error:/)
      }
      assert.equal(await fs.readFile(file, "utf8"), "# Note\\nchanged\\n")
      const before = await fs.readFile(file, "utf8")
      assert.match(await run("edit_file", { path: "memory://note.md", old_text: "changed", new_text: "mixed", edits: [{ op: "append", lines: ["mixed"] }] }), /^error:/)
      assert.equal(await fs.readFile(file, "utf8"), before)
    }
  `
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home, NANO_AGENT_STATE_DIR: path.join(home, "state") },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, output }))
  })
  assert.equal(result.code, 0, result.output)
})
