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

const childHelpers = `
  import { jobsServicePlugin } from "./packages/nano-runtime/src/plugins/jobs-service.ts"
  import { nano } from "./packages/nano-runtime/src/plugins/api.ts"
  import { createRunnerRuntime } from "./packages/nano-runtime/src/runner/index.ts"
  import { createFrontendRunnerRuntime } from "./packages/nano-runtime/src/runner/frontend.ts"
  const frame = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\\n\\n'
  async function until(predicate) {
    for (let i = 0; i < 10000; i++) {
      if (predicate()) return
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.fail('runner did not reach expected state')
  }
  async function createRuntimes(fixture) {
    await fixture.bus.install(jobsServicePlugin)
    const services = { ...fixture.services, jobs: fixture.bus.get(nano.jobs) }
    const frontend = createFrontendRunnerRuntime(services)
    const main = createRunnerRuntime(services, frontend)
    await main.recoverModelSwapHandoff()
    return { services, main, frontend }
  }
`

function childScript(frontendPreset: string | undefined): string {
  const inheritedFrontend = frontendPreset === undefined
  return `
    import assert from "node:assert/strict"
    import fs from "node:fs/promises"
    import path from "node:path"
    import { createExecutionServices } from "./packages/nano-runtime/src/test-model-provider.ts"
    const fixture = await createExecutionServices({ home: process.env.NANO_HOME, dbPath: path.join(process.env.NANO_HOME, "nano.db"), removeHomeOnClose: false, hashline: false })
    await fs.mkdir(path.join(process.env.NANO_HOME, "memories", "journal"), { recursive: true })
    ${childHelpers}
    const { services, main: runner, frontend } = await createRuntimes(fixture)
    const persistence = services.persistence
    const requests = []
    const handoffs = []
    const handoffCounts = { main: 0, frontend: 0 }
    const endRequestIndexes = {}
    let openHandoff
    const handoffBarrier = new Promise(resolve => { openHandoff = resolve })
    const inheritedFrontend = ${JSON.stringify(inheritedFrontend)}
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
            { index: 0, id: lane + '-file', type: 'function', function: { name: 'memory_fs', arguments: JSON.stringify({ file_name: 'journal/' + lane + '-model-swap.md', op: 'create' }) } },
            { index: 1, id: lane + '-edit', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'memory://journal/' + lane + '-model-swap.md', old_text: '', new_text: 'journaled-' + lane + '-before-swap' }) } }
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
    const mainWake = runner.wake({ source: "chat", content: "initial-main-session-proof", triggeredAt: new Date().toISOString(), raw: null })
    const frontendWake = frontend.wakeFrontend({ source: "chat", content: "initial-frontend-session-proof", triggeredAt: new Date().toISOString(), raw: null })
    await until(() => requests.some(r => r.lane === "main" && r.url === "https://old.fixture.invalid/v1/chat/completions") && requests.some(r => r.lane === "frontend" && r.url === ${frontendPreset ? "'https://frontend.fixture.invalid/v1/chat/completions'" : "'https://old.fixture.invalid/v1/chat/completions'"}) && (runner.isRunning() || frontend.isFrontendRunning()))
    const swapping = runner.requestModelSwap("next")
    await until(() => handoffs.length === ${inheritedFrontend ? "2" : "1"})
    if (inheritedFrontend) {
      assert.deepEqual(handoffs.map(item => item.lane).sort(), ["frontend", "main"])
      assert.equal(frontend.enqueueFrontendEvent({ source: "chat", content: "held-frontend-work-proof", triggeredAt: new Date().toISOString(), raw: null }, { priority: true }), true)
      assert.equal(frontend.activateFrontend({ source: "chat", content: "held-frontend-activation-one", triggeredAt: new Date().toISOString(), raw: null }), true)
      assert.equal(frontend.activateFrontend({ source: "chat", content: "held-frontend-activation-two", triggeredAt: new Date().toISOString(), raw: null }), true)
      openHandoff()
      assert.equal((await swapping).graceful, true, "both journal/end handoffs complete gracefully")
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
      assert.ok(JSON.stringify(requests[firstNewFrontendIndex].body.messages).includes("held-frontend-activation-one"))
      assert.ok(JSON.stringify(requests[firstNewFrontendIndex].body.messages).includes("held-frontend-activation-two"))
      assert.equal(requests[firstNewFrontendIndex].body.messages.some(m => m.role === "assistant" && JSON.stringify(m).includes("frontend old session ready")), false,
        "fresh inherited frontend context does not replay the outgoing assistant transcript")
    } else {
      await swapping
      assert.equal(handoffCounts.frontend, 0, "explicit frontend preset is excluded from inherited-lane handoff")
      assert.equal(requests.some(r => r.url === "https://frontend.fixture.invalid/v1/chat/completions" && r.body.model !== "frontend-pinned-model"), false)
      await until(() => requests.some(r => r.url === "https://new.fixture.invalid/v1/chat/completions" && r.lane === "main"))
      const selectedMainIndex = requests.findIndex(r => r.url === "https://new.fixture.invalid/v1/chat/completions" && r.lane === "main")
      assert.ok(endRequestIndexes.main < selectedMainIndex, "main old-model journal/end precedes selected request")
      assert.equal(frontend.enqueueFrontendEvent({ source: "chat", content: "explicit-frontend-still-active", triggeredAt: new Date().toISOString(), raw: null }), true)
      await until(() => requests.some(r => r.url === "https://frontend.fixture.invalid/v1/chat/completions" && JSON.stringify(r.body.messages).includes("explicit-frontend-still-active")))
      const pinnedRequest = requests.find(r => r.url === "https://frontend.fixture.invalid/v1/chat/completions" && JSON.stringify(r.body.messages).includes("explicit-frontend-still-active"))
      assert.ok(pinnedRequest)
      assert.equal(pinnedRequest.body.model, "frontend-pinned-model")
      assert.equal(pinnedRequest.authorization, "Bearer frontend-key")
    }
    await runner.cleanup()
    await frontend.cleanup()
    await fixture.close()
    await Promise.all([mainWake, frontendWake])
  `
}
function frontendFallbackScript(): string {
  return `
    import assert from "node:assert/strict"
    import { createHash } from "node:crypto"
    import fs from "node:fs/promises"
    import path from "node:path"
    import { createExecutionServices } from "./packages/nano-runtime/src/test-model-provider.ts"
    import { createRuntimeContext } from "./packages/nano-runtime/src/runner/context.ts"
    import { createNiriToolCatalog } from "./packages/nano-runtime/src/runner/tool-catalog.ts"
    const fixture = await createExecutionServices({ home: process.env.NANO_HOME, dbPath: path.join(process.env.NANO_HOME, "nano.db"), removeHomeOnClose: false, hashline: false })
    await fs.mkdir(path.join(process.env.NANO_HOME, "memories", "journal"), { recursive: true })
    ${childHelpers}
    const { services, main: runner, frontend } = await createRuntimes(fixture)
    const marker = "frontend-raw-resumable-marker-must-not-cross-model-swap"
    const catalog = createNiriToolCatalog({
      contributions: services.tools.list("frontend"),
      clientCapabilities: [],
      workspace: null,
      frontend: true,
      vision: services.model.current("frontend").primaryVision,
    })
    const messages = [{ role: "user", content: marker, timestamp: 1 }]
    const context = createRuntimeContext("frontend", messages, catalog, undefined,
      services.providerResolver, value => services.images.prepareMessages(value), services.model)
    await services.persistence.saveSession({
      version: 1,
      messages,
      contextId: context.id,
      contextConfigurationFingerprint: context.configurationFingerprint,
      contextModelId: context.model.id,
      toolCatalog: catalog,
      toolCatalogEpoch: 1,
      toolCatalogFingerprint: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"),
    }, "frontend")
    const seeded = await services.persistence.loadSession("frontend")
    assert.ok(seeded)
    assert.equal(seeded.contextModelId, "old-model")
    assert.ok(JSON.stringify(seeded.messages).includes(marker))

    const requests = []
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      const body = JSON.parse(String(init.body))
      requests.push({ url, body, authorization: new Headers(init.headers).get("authorization") })
      assert.equal(url, "https://new.fixture.invalid/v1/chat/completions", "turn-limit fallback must not run outgoing inference")
      return new Response(frame({ content: "selected fixture response" }, "stop") + "data: [DONE]\\n\\n", { headers: { "content-type": "text/event-stream" } })
    }

    const result = await runner.requestModelSwap("next", { gracefulTurnLimit: 0, boundaryWaitMs: 100, toolSettleMs: 100, gracefulDeadlineMs: 100 })
    assert.equal(result.graceful, false, "the outgoing handoff used the configured turn-limit fallback")
    await until(() => requests.some(request => JSON.stringify(request.body.messages).includes("virtual frontend agent")))
    const selectedFrontend = requests.find(request => JSON.stringify(request.body.messages).includes("virtual frontend agent"))
    assert.ok(selectedFrontend)
    assert.equal(selectedFrontend.body.model, "new-model")
    assert.equal(selectedFrontend.authorization, "Bearer new-key")
    assert.equal(JSON.stringify(selectedFrontend.body.messages).includes(marker), false,
      "selected frontend wake must bootstrap without the outgoing resumable transcript")
    const resumed = await services.persistence.loadSession("frontend")
    assert.ok(resumed)
    assert.equal(resumed.contextModelId, "new-model", "the selected frontend wake persists its selected context model")

    await runner.cleanup()
    await frontend.cleanup()
    await fixture.close()
  `
}

function coldWakeCleanupScript(): string {
  return `
    import assert from "node:assert/strict"
    import path from "node:path"
    import { createExecutionServices } from "./packages/nano-runtime/src/test-model-provider.ts"
    const fixture = await createExecutionServices({ home: process.env.NANO_HOME, dbPath: path.join(process.env.NANO_HOME, "nano.db"), removeHomeOnClose: false, hashline: false })
    ${childHelpers}
    const { main: runner, frontend } = await createRuntimes(fixture)
    const requests = []
    globalThis.fetch = async input => {
      requests.push(String(input))
      return new Response(frame({ content: "must not be requested" }, "stop") + "data: [DONE]\\n\\n", { headers: { "content-type": "text/event-stream" } })
    }
    const event = { source: "chat", content: "activation immediately followed by cleanup", triggeredAt: new Date().toISOString(), raw: null }
    runner.activate(event)
    const runnerCleanup = runner.cleanup()
    frontend.activateFrontend(event)
    const frontendCleanup = frontend.cleanup()
    await Promise.all([runnerCleanup, frontendCleanup])
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(runner.isRunning(), false)
    assert.equal(frontend.isFrontendRunning(), false)
    assert.deepEqual(requests, [], "same-turn cleanup settles cold activations before any provider request")
    await fixture.close()
  `
}

test("fallback from a resting frontend discards its resumable context before selected-model wake", { timeout: 30_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-model-swap-frontend-fallback-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const result = await runChild(home, fixtureConfig, frontendFallbackScript())
  assert.equal(result.code, 0, result.output)
})

test("cleanup in the activation turn settles cold main and frontend wakes without provider requests", { timeout: 30_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-cold-wake-cleanup-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const result = await runChild(home, fixtureConfig, coldWakeCleanupScript())
  assert.equal(result.code, 0, result.output)
})

test("inherited frontend closes with main, then replays held work in fresh selected-model context", { timeout: 30_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-model-swap-frontend-inherited-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const result = await runChild(home, fixtureConfig, childScript(undefined))
  assert.equal(result.code, 0, result.output)
})

test("an explicitly configured frontend preset stays outside the main model swap", { timeout: 30_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-model-swap-frontend-pinned-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const result = await runChild(home, { ...fixtureConfig, frontend: { enable: true, preset: "frontendOnly" } }, childScript("frontendOnly"))
  assert.equal(result.code, 0, result.output)
})
