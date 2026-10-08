import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")

for (const lane of ["main", "frontend"] as const) {
  test(`${lane}: inference EOF uses discard archive, excludes partial output and never resumes full context`, { timeout: 30000 }, async t => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-inference-discard-"))
    const configPath = path.join(home, "config.json")
    await fs.writeFile(configPath, JSON.stringify({
      agent: { env: "production" },
      frontend: { enable: true },
      model: { provider: "openai", model: "fixture-model", base_url: "https://fixture.invalid/v1", api_key: "fixture-key" },
    }), "utf8")
    t.after(() => fs.rm(home, { recursive: true, force: true }))
    const script = `
      import assert from "node:assert/strict"
      import fs from "node:fs/promises"
      import path from "node:path"
      import { createHash } from "node:crypto"
      import { createExecutionServices } from "./packages/nano-runtime/src/test-model-provider.ts"
      import { jobsServicePlugin, nano } from "./packages/nano-runtime/src/plugins/index.ts"
      import { createRunnerRuntime } from "./packages/nano-runtime/src/runner/index.ts"
      import { createFrontendRunnerRuntime } from "./packages/nano-runtime/src/runner/frontend.ts"
      const fixture = await createExecutionServices({ home: process.env.NANO_HOME, dbPath: path.join(process.env.NANO_HOME, "nano.db"), removeHomeOnClose: false })
      await fixture.bus.install(jobsServicePlugin)
      const services = { ...fixture.services, jobs: fixture.bus.get(nano.jobs) }
      const frontend = createFrontendRunnerRuntime(services)
      const runner = createRunnerRuntime(services, frontend)
      await runner.recoverModelSwapHandoff()
      const persistence = services.persistence
      const kind = ${JSON.stringify(lane)}
      const run = kind === "main" ? runner.wake : frontend.wakeFrontend
      const stop = async () => { await runner.cleanup(); await frontend.cleanup(); await fixture.close() }
      const toolCatalog = services.tools.list(kind).map(({ definition }) => definition)
      const seed = { version: 1, messages: [{ role: "user", content: "committed earlier history", timestamp: 0 }], toolCatalog, toolCatalogEpoch: 1, toolCatalogFingerprint: createHash("sha256").update(JSON.stringify(toolCatalog)).digest("hex") }
      await persistence.saveSession(seed, kind)
      await persistence.saveRestSnapshot(seed.messages, "existing rest snapshot", kind)
      let requests = 0
      let nextMessages
      const frame = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\\n\\n'
      globalThis.fetch = async (url, init) => {
        assert.equal(String(url), "https://fixture.invalid/v1/chat/completions")
        requests++
        if (requests === 1) return new Response(frame({ tool_calls: [{ index: 0, id: "call_committed", type: "function", function: { name: "memory_fs", arguments: JSON.stringify({ file_name: "discard-proof/", op: "create" }) } }] }, "tool_calls") + 'data: [DONE]\\n\\n', { headers: { "content-type": "text/event-stream" } })
        nextMessages = JSON.parse(String(init.body)).messages
        return new Response(frame({ content: "uncommitted partial" }), { headers: { "content-type": "text/event-stream" } })
      }
      await run({ source: "chat", content: "perform one local tool", triggeredAt: new Date().toISOString(), raw: null })
      assert.equal(await persistence.loadSession(kind), null, "intentional reset must not leave full resume state")
      assert.ok(nextMessages.some(m => m.role === "tool" && m.tool_call_id === "call_committed"))
      const files = await fs.readdir(path.join(process.env.NANO_HOME, "memories"))
      const prefix = kind === "main" ? "discarded-" : "frontend-discarded-"
      const archives = files.filter(name => name.startsWith(prefix) && name.endsWith(".json"))
      assert.equal(archives.length, 1, "inference failure should archive like /discard, not quarantine valid state")
      const archivedText = await fs.readFile(path.join(process.env.NANO_HOME, "memories", archives[0]), "utf8")
      assert.match(await services.memory.readMemory(archives[0]), /committed earlier history/)
      const archive = JSON.parse(archivedText)
      assert.ok(archive.messages.some(m => m.role === "user" && m.content === "committed earlier history"))
      assert.equal(archive.messages.filter(m => m.role === "toolResult" && m.toolCallId === "call_committed").length, 1)
      assert.equal(archivedText.includes("uncommitted partial"), false)
      assert.ok(await persistence.loadRestSnapshot(kind), "existing /discard semantics retain rest snapshot")
      assert.equal(requests, 2)
      await fs.access(path.join(process.env.NANO_HOME, "memories", "discard-proof"))
      await stop()
    `
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: repoRoot,
        env: { PATH: process.env.PATH, HOME: home, NANO_HOME: home, NANO_AGENT_STATE_DIR: path.join(home, "state"), NANO_CONFIG: configPath, NANO_MIGRATE_LEGACY_STATE: "false" },
        stdio: ["ignore", "pipe", "pipe"],
      })
      let output = ""
      child.stdout.on("data", (chunk: Buffer) => { output += chunk })
      child.stderr.on("data", (chunk: Buffer) => { output += chunk })
      child.once("error", reject)
      child.once("close", code => code === 0 ? resolve() : reject(new Error(output)))
    })
    assert.ok((await fs.readdir(home)).every(name => !name.includes(".corrupt-")), "valid checkpoints should be discarded, not marked corrupt")
  })
}
