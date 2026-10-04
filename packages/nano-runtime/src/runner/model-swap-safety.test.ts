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
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(configPath, JSON.stringify(config), "utf8")
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        NANO_HOME: home,
        NANO_AGENT_STATE_DIR: path.join(home, "state"),
        NANO_CONFIG: configPath,
        NANO_MIGRATE_LEGACY_STATE: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`model swap safety fixture exceeded 20 seconds\\n${output}`))
    }, 20_000)
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk })
    child.once("error", (error) => { clearTimeout(timeout); reject(error) })
    child.once("close", (code) => { clearTimeout(timeout); resolve({ code, output }) })
  })
}

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
    import assert from "node:assert/strict"
    import { config } from "./packages/nano-runtime/src/config.ts"
    import { initDb } from "./packages/nano-runtime/src/db.ts"
    import { initMetricsDb } from "./packages/nano-runtime/src/metrics.ts"
    import { modelState, persistedModelPreset } from "./packages/nano-runtime/src/runner/model-state.ts"
    import { __test, wake, isWaitingForEvent, shutdown } from "./packages/nano-runtime/src/runner/index.ts"
    import { loadRestSnapshot, loadSession } from "./packages/nano-runtime/src/runner/session.ts"
    import { grepContext } from "./packages/nano-runtime/src/runner/context-store.ts"
    config.agent.boredom_wake_min = 0
    initDb()
    initMetricsDb()
    const requests = []
    ${sseFrame}
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      const body = JSON.parse(String(init.body))
      requests.push({ url, body })
      if (url === "https://old.fixture.invalid/v1/chat/completions" && body.messages.some(message => JSON.stringify(message).includes("[model swap handoff]"))) {
        // Model an unresponsive provider request that only settles when the runner aborts it.
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
    const initial = wake({ source: "chat", content: "outgoing-timeout-history-proof", triggeredAt: new Date().toISOString(), raw: null })
    await until(() => requests.length > 0 && isWaitingForEvent())
    const result = await __test.requestModelSwap("next", {
      boundaryWaitMs: 0, toolSettleMs: 500, gracefulDeadlineMs: 25, gracefulTurnLimit: 8,
    })
    assert.equal(result.graceful, false)
    assert.match(result.fallbackReason, /deadline/)
    assert.equal(modelState.primaryModel?.id, "new-model")
    assert.equal(persistedModelPreset, "next")
    const rest = await loadRestSnapshot("main", false)
    assert.ok(rest, "timed-out history must be archived before switching providers")
    assert.ok(grepContext("outgoing-timeout-history-proof").length > 0, "immutable history provenance must survive timeout fallback")
    const outgoing = await loadSession("main")
    assert.ok(outgoing)
    assert.equal(outgoing.contextModelId, "new-model")
    assert.equal(outgoing.messages.some(message => JSON.stringify(message).includes("outgoing-timeout-history-proof")), false)
    await until(() => requests.some(request => request.url === "https://new.fixture.invalid/v1/chat/completions"))
    const selected = requests.find(request => request.url === "https://new.fixture.invalid/v1/chat/completions")
    assert.ok(selected)
    assert.equal(selected.body.model, "new-model")
    assert.equal(selected.body.messages.some(message => JSON.stringify(message).includes("outgoing-timeout-history-proof")), false)
    await shutdown()
    await initial
  `
  const result = await runChild(home, fixtureConfig, script)
  assert.equal(result.code, 0, result.output)
})

test("a cancelled mutating job that has not settled blocks swap before any provider request", { timeout: 30_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-model-swap-safety-job-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const script = `
    import assert from "node:assert/strict"
    import { config } from "./packages/nano-runtime/src/config.ts"
    import { initDb } from "./packages/nano-runtime/src/db.ts"
    import { initMetricsDb } from "./packages/nano-runtime/src/metrics.ts"
    import { modelState, persistedModelPreset } from "./packages/nano-runtime/src/runner/model-state.ts"
    import { __test } from "./packages/nano-runtime/src/runner/index.ts"
    import { initJobManager, startJob, cancelJob, hasExecutingJobs } from "./packages/nano-runtime/src/runner/jobs.ts"
    config.agent.boredom_wake_min = 0
    initDb()
    initMetricsDb()
    initJobManager(() => {})
    const requests = []
    globalThis.fetch = async input => {
      requests.push(String(input))
      throw new Error("inference must not begin while the cancelled job is still executing")
    }
    let finish
    const unresolved = new Promise(resolve => { finish = resolve })
    const id = startJob("stuck-mutator", async () => {
      await unresolved
      return "settled"
    }, { notifyOnCompletion: false })
    cancelJob(id, "test cancellation")
    assert.equal(hasExecutingJobs(), true, "job cancellation is not proof its mutation stopped")
    const originalModel = modelState.primaryModel?.id
    await assert.rejects(
      __test.requestModelSwap("next", { boundaryWaitMs: 0 }),
      /background tasks are still executing/,
    )
    assert.equal(modelState.primaryModel?.id, originalModel)
    assert.equal(persistedModelPreset, undefined)
    assert.deepEqual(requests, [], "swap rejection must precede incoming or selected provider calls")
    finish()
  `
  const result = await runChild(home, fixtureConfig, script)
  assert.equal(result.code, 0, result.output)
})
