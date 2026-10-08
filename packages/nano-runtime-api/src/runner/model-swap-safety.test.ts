import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")

type ChildResult = { code: number | null; output: string }

async function runChild(home: string, config: Record<string, unknown>, script: string): Promise<ChildResult> {
  const configPath = path.join(home, "config.json")
  const childTestPath = path.join(repoRoot, `.model-swap-safety-${process.pid}-${Math.random().toString(36).slice(2)}.test.mjs`)
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(configPath, JSON.stringify(config), "utf8")
  await fs.writeFile(childTestPath, `${childImports}\ntest("model swap fixture", async (t) => {\n${script}\n})\n`, "utf8")
  try {
    let resolve!: (value: ChildResult) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<ChildResult>((yes, no) => { resolve = yes; reject = no })
    const result = { promise, resolve, reject }
    const child = spawn(process.execPath, ["--import", "tsx", "--test", childTestPath], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        NANO_HOME: path.join(home, "default-fixture"),
        NANO_TEST_HOME: home,
        NANO_AGENT_STATE_DIR: path.join(home, "state"),
        NANO_CONFIG: configPath,
        NANO_MIGRATE_LEGACY_STATE: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      result.reject(new Error(`model swap safety fixture exceeded 120 seconds\\n${output}`))
    }, 120_000)
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk })
    child.once("error", (error) => { clearTimeout(timeout); result.reject(error) })
    child.once("close", (code) => { clearTimeout(timeout); result.resolve({ code, output }) })
    return await result.promise
  } finally {
    await fs.rm(childTestPath, { force: true })
  }
}

const childImports = `
import assert from "node:assert/strict"
import path from "node:path"
import { createExecutionServices } from "./packages/nano-runtime-api/src/test-model-provider.ts"
import { jobsServicePlugin } from "@nano/plugin-jobs-service"
import { getService } from "@nano/plugins"
import { nano } from "@nano/runtime-api"
import { createRunnerRuntime } from "@nano/runtime-api/runner"
import { createFrontendRunnerRuntime } from "@nano/runtime-api/runner/frontend"
import { test } from "node:test"
`
const fixtureConfig = {
  agent: { env: "production", boredom_wake_min: 0 },
  discord: { owner_id: "fixture-owner", channel_poll: false, batch_scan: false },
  model: {
    provider: "openai", model: "old-model", base_url: "https://old.fixture.invalid/v1", api_key: "old-key",
    tool_choice: "auto", enable_thinking: false, thinking_effort: "minimal", compaction_strategy: "off", vision: false,
  },
  fallback: { provider: "openai", model: "fallback-model", base_url: "https://fallback.fixture.invalid/v1", api_key: "fallback-key", tool_choice: "auto" },
  models: {
    next: {
      provider: "openai", model: "new-model", base_url: "https://new.fixture.invalid/v1", api_key: "new-key",
      tool_choice: "auto", enable_thinking: false, thinking_effort: "high", vision: true, compaction_strategy: "off",
    },
  },
}

const waitUntil = `async function until(predicate) {
  for (let i = 0; i < 10000; i++) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail("runner did not reach expected state")
}`
const sseFrame = `const frame = (delta, finish_reason = null) => "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + "\\n\\n"`

test("an outgoing generation that ignores the graceful handoff is aborted, archived, and replaced safely", { timeout: 30_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-model-swap-safety-timeout-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const script = `
    const home = path.join(process.env.NANO_TEST_HOME, "runtime-home")
    const fixture = await createExecutionServices({ home, dbPath: path.join(home, "nano.db"), removeHomeOnClose: false })
    await fixture.ctx.plugin(jobsServicePlugin)
    const services = { ...fixture.services, jobs: getService(fixture.ctx, nano.jobs) }
    const frontend = createFrontendRunnerRuntime(services)
    const runner = createRunnerRuntime(services, frontend)
    t.after(async () => { await runner.cleanup(); await frontend.cleanup(); await fixture.close() })
    await runner.recoverModelSwapHandoff()
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
    t.mock.timers.tick(0)
    const requests = []
    ${sseFrame}
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      const body = JSON.parse(String(init.body))
      requests.push({ url, body })
      if (url === "https://old.fixture.invalid/v1/chat/completions" && body.messages.some(message => JSON.stringify(message).includes("[model swap handoff]"))) {
        const signal = init.signal
        if (!signal) throw new Error("handoff request did not receive an abort signal")
        return new Promise((resolve, reject) => {
          const abort = () => reject(signal.reason ?? new Error("aborted"))
          if (signal.aborted) abort()
          else signal.addEventListener("abort", abort, { once: true })
        })
      }
      return new Response(frame({ content: "fresh selected session" }, "stop") + "data: [DONE]\\n\\n", { headers: { "content-type": "text/event-stream" } })
    }
    ${waitUntil}
    runner.activate({ source: "chat", content: "outgoing-timeout-history-proof", triggeredAt: new Date().toISOString(), raw: null })
    await until(() => requests.length > 0 && runner.isWaitingForEvent())
    const swapping = runner.requestModelSwap("next", { boundaryWaitMs: 0, toolSettleMs: 100, gracefulDeadlineMs: 90_000, gracefulTurnLimit: 5 })
    await until(() => requests.some(request => request.body.messages.some(message => JSON.stringify(message).includes("[model swap handoff]"))))
    t.mock.timers.tick(90_000)
    const result = await swapping
    assert.equal(result.graceful, false)
    assert.match(result.fallbackReason ?? "", /deadline/)
    assert.equal(services.model.current("main").primaryModel?.id, "new-model")
    assert.equal(services.model.persistedPreset(), "next")
    const rest = await services.persistence.loadRestSnapshot("main")
    assert.ok(rest, "timed-out history must be archived before switching providers")
    assert.ok(services.persistence.grepContext("outgoing-timeout-history-proof", undefined, undefined, "main").length, "immutable history provenance must survive timeout fallback")
    const outgoing = await services.persistence.loadSession("main")
    assert.ok(outgoing)
    assert.equal(outgoing.contextModelId, "new-model")
    assert.equal(outgoing.messages.some(message => JSON.stringify(message).includes("outgoing-timeout-history-proof")), false)
    await until(() => requests.some(request => request.url === "https://new.fixture.invalid/v1/chat/completions"))
    const selected = requests.find(request => request.url === "https://new.fixture.invalid/v1/chat/completions")
    assert.ok(selected)
    assert.equal(selected.body.messages.some(message => JSON.stringify(message).includes("outgoing-timeout-history-proof")), false)
  `
  const result = await runChild(home, fixtureConfig, script)
  assert.equal(result.code, 0, result.output)
})

test("a cancelled mutating job that has not settled blocks swap before any provider request", { timeout: 30_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-model-swap-safety-job-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const script = `
    const home = path.join(process.env.NANO_TEST_HOME, "runtime-home")
    const fixture = await createExecutionServices({ home, dbPath: path.join(home, "nano.db"), removeHomeOnClose: false })
    await fixture.ctx.plugin(jobsServicePlugin)
    const services = { ...fixture.services, jobs: getService(fixture.ctx, nano.jobs) }
    const frontend = createFrontendRunnerRuntime(services)
    const runner = createRunnerRuntime(services, frontend)
    let finish
    t.after(async () => { finish?.(); await runner.cleanup(); await frontend.cleanup(); await fixture.close() })
    await runner.recoverModelSwapHandoff()
    const jobs = services.jobs
    const requests = []
    globalThis.fetch = async input => {
      requests.push(String(input))
      throw new Error("inference must not begin while the cancelled job is still executing")
    }
    const unresolved = new Promise(resolve => { finish = resolve })
    const id = jobs.startJob("stuck-mutator", async () => {
      await unresolved
      return "settled"
    }, { notifyOnCompletion: false })
    jobs.cancelJob(id, "test cancellation")
    assert.equal(jobs.hasExecutingJobs(), true, "job cancellation is not proof its mutation stopped")
    const originalModel = fixture.services.model.current("main").primaryModel?.id
    await assert.rejects(runner.requestModelSwap("next"), /background tasks are still executing/)
    assert.equal(services.model.current("main").primaryModel?.id, originalModel)
    assert.equal(services.model.persistedPreset(), undefined)
    assert.deepEqual(requests, [], "swap rejection must precede incoming or selected provider calls")
    finish()
  `
  const result = await runChild(home, fixtureConfig, script)
  assert.equal(result.code, 0, result.output)
})
