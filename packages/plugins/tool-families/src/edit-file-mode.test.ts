import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import test from "node:test"

test("memory read/edit handlers honor the pinned catalog mode and reject mismatches without mutation", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-edit-mode-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const config = path.join(home, "config.json")
  const secrets = path.join(home, "secrets.json")
  await fs.writeFile(config, JSON.stringify({ agent: { env: "local" } }))
  await fs.writeFile(secrets, "{}")
  const fixtureUrl = new URL("../../../../tests/support/runtime-services.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    import { createHash } from "node:crypto"
    import fs from "node:fs/promises"
    import path from "node:path"
    import { Context } from "@nano/runtime-api/llm"
    import { createExecutionServices } from ${JSON.stringify(fixtureUrl)}
    import { createNiriToolCatalog } from "@nano/plugin-tools"
    import { executeToolCall } from "@nano/plugin-runner/loop-tool-runtime"

    let id = 0
    for (const hashline of [true, false]) {
      const fixture = await createExecutionServices({
        home: path.join(process.env.NANO_HOME, hashline ? "hashline" : "exact"),
        hashline,
        removeHomeOnClose: true,
      })
      try {
        const services = fixture.services
        const catalog = createNiriToolCatalog({
          contributions: services.tools.list("main"),
          clientCapabilities: services.client.capabilities(),
          workspace: services.client.workspace(),
        })
        const convId = services.persistence.startConversation("edit-mode-test", new Date(0).toISOString())
        const model = services.model.current().fallbackModel
        const state = {
          runtimeKind: "main",
          services,
          context: new Context({ model, providerResolver: fixture.providerResolver, prepareMessages: services.images.prepareMessages }),
          pendingInputs: [],
          tokenCount: 0,
          contextSize: 0,
          toolCatalog: catalog,
          toolCatalogEpoch: 1,
          toolCatalogFingerprint: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"),
          toolInFlight: false,
          memoryRecallCooldowns: {},
          memoryRecallTurn: 0,
          memoryRecallPending: false,
          shutdownRequested: false,
          turnInFlight: false,
          restRequested: false,
          restReason: "",
        }
        const hooks = {
          waitForEvent: async () => null,
          waitForEventWithTimeout: async () => null,
          injectIncomingEvent() {},
          flushDeferredEvents() {},
          refreshToolCatalog() {},
          clearSession: async () => {},
          saveSession: async () => {},
          saveShutdownSnapshot: async () => {},
          shouldShutdown: () => false,
          resolveShutdown() {},
        }
        const file = path.join(fixture.home, "memories", "note.md")
        await fs.mkdir(path.dirname(file), { recursive: true })
        const run = async (name, args) => {
          const call = { type: "toolCall", id: "mode-" + ++id, name, arguments: args }
          await executeToolCall(convId, state, hooks, call)
          const result = state.context.items.at(-1)
          assert.ok(result && result.role === "toolResult")
          assert.equal(result.toolCallId, call.id)
          return result
        }

        await fs.writeFile(file, "# Note\\nfirst\\n")
        const before = await fs.readFile(file, "utf8")
        const wrong = hashline ? { old_text: "first", new_text: "wrong" } : { edits: [{ op: "append", lines: ["wrong"] }] }
        assert.equal((await run("edit_file", { path: "memory://note.md", ...wrong })).isError, true)
        assert.equal(await fs.readFile(file, "utf8"), before)

        const read = await run("read_file", { path: "memory://note.md" })
        const text = read.content.map((part) => part.type === "text" ? part.text : "").join("")
        let correct
        if (hashline) {
          const anchor = text.match(/^(\\d+#[A-Z]+): first$/m)?.[1]
          assert.ok(anchor, text)
          correct = { edits: [{ op: "replace", pos: anchor, lines: ["changed"] }] }
        } else {
          assert.doesNotMatch(text, /^\\d+#[A-Z]+:/m)
          correct = { old_text: "first", new_text: "changed" }
        }
        assert.equal((await run("edit_file", { path: "memory://note.md", ...correct })).isError, false)
        assert.equal(await fs.readFile(file, "utf8"), "# Note\\nchanged\\n")

        if (!hashline) {
          await fs.writeFile(file, "")
          assert.equal((await run("edit_file", { path: "memory://note.md", old_text: "", new_text: "# Note\\ninitialized\\n" })).isError, false)
          assert.equal(await fs.readFile(file, "utf8"), "# Note\\ninitialized\\n")
        }
        services.persistence.endConversation(convId, 0)
      } finally {
        await fixture.close()
      }
    }
  `
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home, HOME: home, NANO_AGENT_STATE_DIR: path.join(home, "state"), NANO_CONFIG: config, NANO_SECRETS: secrets },
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
