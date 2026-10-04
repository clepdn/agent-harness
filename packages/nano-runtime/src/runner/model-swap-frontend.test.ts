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
  let resolveChild!: (result: ChildResult) => void
  let rejectChild!: (error: Error) => void
  const done = new Promise<ChildResult>((resolve, reject) => {
    resolveChild = resolve
    rejectChild = reject
  })
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
    timeout: 20_000,
  })
  let output = ""
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk })
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk })
  child.once("error", rejectChild)
  child.once("close", (code) => resolveChild({ code, output }))
  return done
}

const fixtureConfig = {
  agent: { env: "production", boredom_wake_min: 0 },
  discord: { owner_id: "fixture-owner", channel_poll: false, batch_scan: false },
  frontend: { enable: true },
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
    frontendOnly: {
      provider: "openai", model: "frontend-pinned-model", base_url: "https://frontend.fixture.invalid/v1", api_key: "frontend-key",
      tool_choice: "auto", enable_thinking: false, thinking_effort: "minimal", compaction_strategy: "off",
    },
  },
}

const testBounds = { boundaryWaitMs: 0, toolSettleMs: 100, gracefulDeadlineMs: 5_000, gracefulTurnLimit: 5 }
const childHelpers = `
  const frame = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\\n\\n'
  async function until(predicate) {
    for (let i = 0; i < 10000; i++) {
      if (predicate()) return
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.fail('runner did not reach expected state')
  }
`

function childScript(frontendPreset: string | undefined): string {
  const inheritedFrontend = frontendPreset === undefined
  const configSetup = frontendPreset ? `config.frontend.preset = ${JSON.stringify(frontendPreset)}` : ""
  return `
    import assert from "node:assert/strict"
    import { config } from "./packages/nano-runtime/src/config.ts"
    import { initDb } from "./packages/nano-runtime/src/db.ts"
    import fs from "node:fs/promises"
    import path from "node:path"
    import { initMetricsDb } from "./packages/nano-runtime/src/metrics.ts"
    import { __test, isRunning, isWaitingForEvent, wake, shutdown } from "./packages/nano-runtime/src/runner/index.ts"
    import { enqueueFrontendEvent, getFrontendRunnerStatus, shutdownFrontend, wakeFrontend } from "./packages/nano-runtime/src/runner/frontend.ts"
    config.agent.boredom_wake_min = 0
    ${configSetup}
    initDb()
    initMetricsDb()
    const inheritedFrontend = ${JSON.stringify(inheritedFrontend)}
    const requests = []
    const handoffs = []
    const handoffCounts = { main: 0, frontend: 0 }
    const endRequestIndexes = {}
    let openHandoff
    const handoffBarrier = new Promise(resolve => { openHandoff = resolve })
    ${childHelpers}
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      const body = JSON.parse(String(init.body))
      const allText = JSON.stringify(body.messages)
      const lane = allText.includes("virtual frontend agent") ? "frontend" : "main"
      const request = { url, body, lane, authorization: new Headers(init.headers).get("authorization") }
      requests.push(request)
      const isHandoff = allText.includes("[model swap handoff]")
      if (isHandoff && url === "https://old.fixture.invalid/v1/chat/completions") {
        const count = ++handoffCounts[lane]
        handoffs.push({ lane, count, index: requests.length - 1, body })
        if (count === 1 && inheritedFrontend) {
          // Hold both outgoing lanes at their first provider request so queued
          // frontend work cannot race with old-session closure.
          await handoffBarrier
        }
        if (count === 1) {
          return new Response(frame({ tool_calls: [
            { index: 0, id: lane + '-dir', type: 'function', function: { name: 'memory_fs', arguments: JSON.stringify({ file_name: 'journal/', op: 'create' }) } },
            { index: 1, id: lane + '-file', type: 'function', function: { name: 'memory_fs', arguments: JSON.stringify({ file_name: 'journal/' + lane + '-model-swap.md', op: 'create' }) } },
            { index: 2, id: lane + '-edit', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'memory://journal/' + lane + '-model-swap.md', old_text: '', new_text: 'journaled-' + lane + '-before-swap' }) } },
          ] }, 'tool_calls') + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } })
        }
        assert.equal(count, 2, lane + ' should journal once, then end')
        const journal = body.messages.find(m => m.role === 'tool' && m.tool_call_id === lane + '-edit')
        assert.ok(journal, lane + ' journal edit result is preserved before end_session')
        assert.match(journal.content ?? '', /edited /)
        assert.equal(await fs.readFile(path.join(process.env.NANO_HOME, 'memories', 'journal', lane + '-model-swap.md'), 'utf8'), 'journaled-' + lane + '-before-swap')
        endRequestIndexes[lane] = requests.length - 1
        return new Response(frame({ tool_calls: [{ index: 0, id: lane + '-end', type: 'function', function: { name: 'end_session', arguments: JSON.stringify({ note: 'model handoff' }) } }] }, 'tool_calls') + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      if (url === "https://old.fixture.invalid/v1/chat/completions") {
        assert.equal(request.authorization, "Bearer old-key")
        return new Response(frame({ content: lane + " old session ready" }, "stop") + "data: [DONE]\\n\\n", { headers: { "content-type": "text/event-stream" } })
      }
      if (url === "https://new.fixture.invalid/v1/chat/completions") {
        return new Response(frame({ content: lane + " new session ready" }, "stop") + "data: [DONE]\\n\\n", { headers: { "content-type": "text/event-stream" } })
      }
      if (url === "https://frontend.fixture.invalid/v1/chat/completions") {
        return new Response(frame({ content: "pinned frontend session ready" }, "stop") + "data: [DONE]\\n\\n", { headers: { "content-type": "text/event-stream" } })
      }
      assert.fail("unexpected provider request: " + url)
    }
    const mainWake = wake({ source: "chat", content: "initial-main-session-proof", triggeredAt: new Date().toISOString(), raw: null })
    const frontendWake = wakeFrontend({ source: "chat", content: "initial-frontend-session-proof", triggeredAt: new Date().toISOString(), raw: null })
    await until(() => requests.some(r => r.lane === "main" && r.url === "https://old.fixture.invalid/v1/chat/completions") &&
      requests.some(r => r.lane === "frontend" && r.url === ${frontendPreset ? "'https://frontend.fixture.invalid/v1/chat/completions'" : "'https://old.fixture.invalid/v1/chat/completions'"}) &&
      isRunning() && isWaitingForEvent() && getFrontendRunnerStatus().running && getFrontendRunnerStatus().idle)
    const swapping = __test.requestModelSwap("next", ${JSON.stringify(testBounds)})
    await until(() => handoffs.length === ${inheritedFrontend ? "2" : "1"})
    if (inheritedFrontend) {
      assert.deepEqual(handoffs.map(item => item.lane).sort(), ["frontend", "main"])
      assert.equal(enqueueFrontendEvent({ source: "chat", content: "held-frontend-work-proof", triggeredAt: new Date().toISOString(), raw: null }), true)
      openHandoff()
      await swapping
      await until(() => requests.some(r => r.url === "https://new.fixture.invalid/v1/chat/completions" && r.lane === "main") &&
        requests.some(r => r.url === "https://new.fixture.invalid/v1/chat/completions" && r.lane === "frontend" && JSON.stringify(r.body.messages).includes("held-frontend-work-proof")))
      const firstSelectedIndex = requests.findIndex(r => r.url === "https://new.fixture.invalid/v1/chat/completions" && r.lane === "main")
      const firstNewFrontendIndex = requests.findIndex(r => r.url === "https://new.fixture.invalid/v1/chat/completions" && r.lane === "frontend" && JSON.stringify(r.body.messages).includes("held-frontend-work-proof"))
      assert.ok(endRequestIndexes.main < firstSelectedIndex, "main old-model journal/end precedes selected request")
      assert.ok(endRequestIndexes.frontend < firstNewFrontendIndex, "inherited frontend old-model journal/end precedes selected request")
      assert.equal(handoffCounts.main, 2)
      assert.equal(handoffCounts.frontend, 2)
      assert.equal(requests[firstNewFrontendIndex].body.model, "new-model")
      assert.equal(requests[firstNewFrontendIndex].authorization, "Bearer new-key")
      assert.ok(JSON.stringify(requests[firstNewFrontendIndex].body.messages).includes("held-frontend-work-proof"))
      assert.equal(requests[firstNewFrontendIndex].body.messages.some(m => m.role === "assistant" && JSON.stringify(m).includes("frontend old session ready")), false,
        "fresh inherited frontend context does not replay the outgoing assistant transcript")
    } else {
      await swapping
      assert.equal(handoffCounts.frontend, 0, "explicit frontend preset is excluded from inherited-lane handoff")
      assert.equal(requests.some(r => r.url === "https://frontend.fixture.invalid/v1/chat/completions" && r.body.model !== "frontend-pinned-model"), false)
      await until(() => requests.some(r => r.url === "https://new.fixture.invalid/v1/chat/completions" && r.lane === "main"))
      const selectedMainIndex = requests.findIndex(r => r.url === "https://new.fixture.invalid/v1/chat/completions" && r.lane === "main")
      assert.ok(endRequestIndexes.main < selectedMainIndex, "main old-model journal/end precedes selected request")
      assert.equal(enqueueFrontendEvent({ source: "chat", content: "explicit-frontend-still-active", triggeredAt: new Date().toISOString(), raw: null }), true)
      await until(() => requests.some(r => r.url === "https://frontend.fixture.invalid/v1/chat/completions" && JSON.stringify(r.body.messages).includes("explicit-frontend-still-active")))
      const pinnedRequest = requests.find(r => r.url === "https://frontend.fixture.invalid/v1/chat/completions" && JSON.stringify(r.body.messages).includes("explicit-frontend-still-active"))
      assert.ok(pinnedRequest)
      assert.equal(pinnedRequest.body.model, "frontend-pinned-model")
      assert.equal(pinnedRequest.authorization, "Bearer frontend-key")
    }
    await until(() => isWaitingForEvent() && getFrontendRunnerStatus().idle)
    await shutdownFrontend()
    await shutdown()
    await Promise.all([mainWake, frontendWake])
  `
}

test("inherited frontend closes with main, then replays held work in fresh selected-model context", { timeout: 30_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-model-swap-frontend-inherited-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const result = await runChild(home, fixtureConfig, childScript(undefined))
  assert.equal(result.code, 0, result.output)
})

test("an explicitly configured frontend preset stays outside the main model swap", { timeout: 30_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-model-swap-frontend-pinned-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const result = await runChild(home, fixtureConfig, childScript("frontendOnly"))
  assert.equal(result.code, 0, result.output)
})
