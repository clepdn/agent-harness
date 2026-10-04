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
    stdio: ["ignore", "pipe", "pipe"],
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
  model: {
    provider: "openai", model: "old-model", base_url: "https://old.fixture.invalid/v1", api_key: "old-key",
    tool_choice: "auto", enable_thinking: false, thinking_effort: "minimal", compaction_strategy: "off", vision: false,
  },
  fallback: { provider: "openai", model: "fallback-model", base_url: "https://fallback.fixture.invalid/v1", api_key: "fallback-key", tool_choice: "auto" },
  models: {
    next: {
      provider: "openai", model: "new-model", base_url: "https://new.fixture.invalid/v1", api_key: "new-key",
      tool_choice: "auto", enable_thinking: false, thinking_effort: "high", vision: true, compaction_strategy: "off",
      title: "new-title", referer: "https://ref.fixture.invalid",
    },
    alternate: {
      provider: "anthropic", model: "other-model", base_url: "https://other.fixture.invalid/v1", api_key: "other-key",
      tool_choice: "none", enable_thinking: false, compaction_strategy: "off",
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

test("/model swap immediately wakes an idle runner, journals and ends on old settings, then requests with selected settings and fresh context", { timeout: 30_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-model-swap-idle-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const script = `
    import assert from "node:assert/strict"
    import fs from "node:fs/promises"
    import path from "node:path"
    import { config } from "./packages/nano-runtime/src/config.ts"
    import { initDb } from "./packages/nano-runtime/src/db.ts"
    import { initMetricsDb } from "./packages/nano-runtime/src/metrics.ts"
    import { handleInteraction } from "./packages/nano-runtime/src/discord/slash-commands.ts"
    import { modelState } from "./packages/nano-runtime/src/runner/model-state.ts"
    import { loadRestSnapshot, loadSession } from "./packages/nano-runtime/src/runner/session.ts"
    import { grepContext } from "./packages/nano-runtime/src/runner/context-store.ts"
    import { wake, isRunning, isWaitingForEvent, enqueueEvent, shutdown } from "./packages/nano-runtime/src/runner/index.ts"
    config.agent.boredom_wake_min = 0
    initDb()
    initMetricsDb()
    modelState.primaryNudgeOnNoTool = false
    const requests = []
    const handoffRequests = []
    ${childHelpers}
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      const body = JSON.parse(String(init.body))
      const headers = new Headers(init.headers)
      const request = { url, body, authorization: headers.get('authorization'), title: headers.get('x-title'), referer: headers.get('http-referer') }
      requests.push(request)
      if (url === 'https://old.fixture.invalid/v1/chat/completions') {
        assert.equal(request.authorization, 'Bearer old-key')
        if (body.messages.some(m => JSON.stringify(m).includes('[model swap handoff]'))) {
          handoffRequests.push(request)
          if (handoffRequests.length === 1) {
            return new Response(frame({ tool_calls: [
              { index: 0, id: 'dir-call', type: 'function', function: { name: 'memory_fs', arguments: JSON.stringify({ file_name: 'journal/', op: 'create' }) } },
              { index: 1, id: 'file-call', type: 'function', function: { name: 'memory_fs', arguments: JSON.stringify({ file_name: 'journal/model-swap.md', op: 'create' }) } },
              { index: 2, id: 'journal-call', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'memory://journal/model-swap.md', old_text: '', new_text: 'journaled old-task-proof' }) } },
            ] }, 'tool_calls') + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } })
          }
          assert.ok(body.messages.some(m => m.role === 'tool' && m.tool_call_id === 'journal-call'))
          return new Response(frame({ tool_calls: [{ index: 0, id: 'end-call', type: 'function', function: { name: 'end_session', arguments: JSON.stringify({ note: 'journaled model handoff' }) } }] }, 'tool_calls') + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } })
        }
        return new Response(frame({ content: 'old idle session ready' }, 'stop') + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      assert.equal(url, 'https://new.fixture.invalid/v1/chat/completions')
      return new Response(frame({ content: 'new model fresh session' }, 'stop') + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    const firstWake = wake({ source: 'chat', content: 'initial old session work', triggeredAt: new Date().toISOString(), raw: null })
    await until(() => isRunning() && isWaitingForEvent() && requests.length > 0)
    let deferred = false
    let edited
    const interaction = {
      user: { id: 'fixture-owner' }, commandName: 'model',
      options: { getSubcommand: () => 'swap', getString: () => 'next' },
      deferReply: async options => { deferred = true; assert.equal(options.ephemeral, true) },
      editReply: async content => { assert.equal(deferred, true); edited = content },
      reply: async () => assert.fail('swap must defer before the lifecycle completes'),
    }
    const firstRequestAtSwap = requests.length
    const command = handleInteraction(interaction)
    await until(() => handoffRequests.length === 1)
    assert.ok(deferred, 'Discord acknowledges before the outgoing model starts handoff work')
    assert.equal(requests[firstRequestAtSwap]?.url, 'https://old.fixture.invalid/v1/chat/completions', 'idle swap triggers the outgoing provider without another incoming event')
    assert.equal(enqueueEvent({ source: 'chat', content: 'held-new-work-proof', triggeredAt: new Date().toISOString(), raw: null }), true)
    await command
    assert.match(edited, /graceful end path|gracefully/i)
    await until(() => requests.some(r => r.url === 'https://new.fixture.invalid/v1/chat/completions'))
    assert.equal(handoffRequests.length, 2)
    assert.ok(handoffRequests[1].body.messages.some(m => m.role === 'tool' && m.tool_call_id === 'journal-call'))
    const selectedRequest = requests.find(r => r.url === 'https://new.fixture.invalid/v1/chat/completions')
    assert.ok(selectedRequest)
    assert.equal(selectedRequest.body.model, 'new-model')
    assert.equal(selectedRequest.authorization, 'Bearer new-key')
    assert.equal(selectedRequest.title, 'new-title')
    assert.equal(selectedRequest.referer, 'https://ref.fixture.invalid')
    assert.equal(selectedRequest.body.tool_choice, 'auto')
    assert.ok(selectedRequest.body.messages.some(m => JSON.stringify(m).includes('held-new-work-proof')))
    assert.equal(selectedRequest.body.messages.some(m => JSON.stringify(m).includes('old-task-proof')), false, 'new provider never receives the outgoing raw transcript')
    assert.match(await fs.readFile(path.join(process.env.NANO_HOME, 'memories', 'journal', 'model-swap.md'), 'utf8'), /old-task-proof/)
    const rest = await loadRestSnapshot('main', false)
    assert.ok(rest)
    assert.match(rest.summary, /context-summary-id/)
    const selectedSession = await loadSession('main')
    assert.ok(selectedSession)
    assert.equal(selectedSession.contextModelId, 'new-model')
    assert.equal(selectedSession.messages.some(m => JSON.stringify(m).includes('old-task-proof')), false)
    assert.ok(grepContext('end_session').length > 0)
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(process.env.NANO_HOME, 'model-selection.json'), 'utf8')), { preset: 'next' })
    await until(() => isWaitingForEvent())
    await shutdown()
    await firstWake
  `
  const result = await runChild(home, fixtureConfig, script)
  assert.equal(result.code, 0, result.output)
})

test("invalid and overlapping swaps preserve old settings, and busy work settles before queued input reaches the new provider", { timeout: 30_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-model-swap-busy-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const script = `
    import assert from "node:assert/strict"
    import { config } from "./packages/nano-runtime/src/config.ts"
    import { initDb } from "./packages/nano-runtime/src/db.ts"
    import { initMetricsDb } from "./packages/nano-runtime/src/metrics.ts"
    import { modelState, persistedModelPreset } from "./packages/nano-runtime/src/runner/model-state.ts"
    import { __test, enqueueEvent, isRunning, isWaitingForEvent, wake, shutdown } from "./packages/nano-runtime/src/runner/index.ts"
    config.agent.boredom_wake_min = 0
    initDb()
    initMetricsDb()
    const requests = []
    const order = []
    let release
    let blocked = false
    ${childHelpers}
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      const body = JSON.parse(String(init.body))
      requests.push({ url, body, authorization: new Headers(init.headers).get('authorization') })
      if (url === 'https://old.fixture.invalid/v1/chat/completions' && body.messages.some(m => JSON.stringify(m).includes('hold-old-request')) && !body.messages.some(m => JSON.stringify(m).includes('[model swap handoff]'))) {
        blocked = true
        await new Promise(resolve => { release = resolve })
        order.push('old-generation-settled')
        return new Response(frame({ content: 'old held generation settled' }, 'stop') + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      if (url === 'https://old.fixture.invalid/v1/chat/completions' && body.messages.some(m => JSON.stringify(m).includes('[model swap handoff]'))) {
        if (body.messages.some(m => m.role === 'assistant' && JSON.stringify(m).includes('memory_fs'))) {
          return new Response(frame({ tool_calls: [{ index: 0, id: 'end-call', type: 'function', function: { name: 'end_session', arguments: JSON.stringify({ note: 'done' }) } }] }, 'tool_calls') + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } })
        }
        return new Response(frame({ tool_calls: [{ index: 0, id: 'journal-call', type: 'function', function: { name: 'memory_fs', arguments: JSON.stringify({ file_name: 'journal/', op: 'create' }) } }] }, 'tool_calls') + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      if (url === 'https://new.fixture.invalid/v1/chat/completions') order.push('new-generation-started')
      return new Response(frame({ content: 'fresh selected session' }, 'stop') + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    const originalModel = modelState.primaryModel?.id
    await assert.rejects(__test.requestModelSwap('missing', { boundaryWaitMs: 0 }), /model preset.*not found/)
    assert.equal(modelState.primaryModel?.id, originalModel)
    assert.equal(persistedModelPreset, undefined)
    const initial = wake({ source: 'chat', content: 'hold-old-request', triggeredAt: new Date().toISOString(), raw: null })
    await until(() => blocked && release !== undefined)
    const options = ${JSON.stringify(testBounds)}
    const swapping = __test.requestModelSwap('next', options)
    await assert.rejects(__test.requestModelSwap('alternate', options), /model swap already in progress/)
    assert.equal(enqueueEvent({ source: 'chat', content: 'queued-work-proof', triggeredAt: new Date().toISOString(), raw: null }), true)
    assert.equal(requests.some(r => r.url === 'https://new.fixture.invalid/v1/chat/completions'), false)
    release()
    await swapping
    await until(() => requests.some(r => r.url === 'https://new.fixture.invalid/v1/chat/completions' && r.body.messages.some(m => JSON.stringify(m).includes('queued-work-proof'))))
    const fresh = requests.find(r => r.url === 'https://new.fixture.invalid/v1/chat/completions')
    assert.ok(fresh)
    assert.equal(fresh.authorization, 'Bearer new-key')
    assert.ok(fresh.body.messages.some(m => JSON.stringify(m).includes('queued-work-proof')))
    assert.equal(fresh.body.messages.some(m => JSON.stringify(m).includes('hold-old-request')), false)
    assert.ok(order.indexOf('old-generation-settled') >= 0)
    assert.ok(order.indexOf('new-generation-started') > order.indexOf('old-generation-settled'))
    await until(() => isWaitingForEvent())
    await shutdown()
    await initial
  `
  const result = await runChild(home, fixtureConfig, script)
  assert.equal(result.code, 0, result.output)
})

test("failed graceful handoff archives raw provenance and a crashed handoff restores the selected preset and queued event", { timeout: 30_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-model-swap-restart-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const seedCrash = `
    import { saveModelSwapHandoff } from "./packages/nano-runtime/src/runner/session.ts"
    await saveModelSwapHandoff({
      version: 1,
      id: 'crash-fixture',
      preset: 'next',
      phase: 'closing',
      messages: [{ role: 'user', content: 'crash-raw-transcript-proof', timestamp: 1 }],
      events: [{ source: 'chat', content: 'crash-queued-task-proof', triggeredAt: new Date().toISOString(), raw: null }],
      note: 'simulated process crash while a swap was closing',
    })
  `
  const seeded = await runChild(home, fixtureConfig, seedCrash)
  assert.equal(seeded.code, 0, seeded.output)

  const restartScript = `
    import assert from "node:assert/strict"
    import { initDb } from "./packages/nano-runtime/src/db.ts"
    import { initMetricsDb } from "./packages/nano-runtime/src/metrics.ts"
    import { modelState, persistedModelPreset } from "./packages/nano-runtime/src/runner/model-state.ts"
    import { wake, shutdown, recoverModelSwapHandoff } from "./packages/nano-runtime/src/runner/index.ts"
    import { grepContext } from "./packages/nano-runtime/src/runner/context-store.ts"
    initDb()
    initMetricsDb()
    await recoverModelSwapHandoff()
    assert.equal(persistedModelPreset, 'next')
    assert.equal(modelState.primaryModel?.id, 'new-model')
    let request
    const frame = delta => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: 'stop' }] }) + '\\n\\n'
    globalThis.fetch = async (input, init) => {
      request = { url: String(input), body: JSON.parse(String(init.body)), authorization: new Headers(init.headers).get('authorization') }
      return new Response(frame({ content: 'restored selected preset with pending work' }) + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    const restarted = wake({ source: 'system', content: 'process restarted', triggeredAt: new Date().toISOString(), raw: null })
    for (let i = 0; i < 10000 && !request; i++) await new Promise(resolve => setImmediate(resolve))
    assert.ok(request)
    assert.equal(request.url, 'https://new.fixture.invalid/v1/chat/completions')
    assert.equal(request.body.model, 'new-model')
    assert.equal(request.authorization, 'Bearer new-key')
    assert.ok(request.body.messages.some(m => JSON.stringify(m).includes('crash-queued-task-proof')))
    assert.ok(request.body.messages.some(m => JSON.stringify(m).includes('process restarted')))
    assert.equal(request.body.messages.some(m => JSON.stringify(m).includes('crash-raw-transcript-proof')), false)
    assert.ok(grepContext('crash-raw-transcript-proof').length > 0)
    await shutdown()
    await restarted
  `
  const recovered = await runChild(home, fixtureConfig, restartScript)
  assert.equal(recovered.code, 0, recovered.output)

  const failedCloseHome = await fs.mkdtemp(path.join(os.tmpdir(), "nano-model-swap-fallback-"))
  t.after(() => fs.rm(failedCloseHome, { recursive: true, force: true }))
  const failureScript = `
    import assert from "node:assert/strict"
    import { config } from "./packages/nano-runtime/src/config.ts"
    import { initDb } from "./packages/nano-runtime/src/db.ts"
    import { initMetricsDb } from "./packages/nano-runtime/src/metrics.ts"
    import { modelState } from "./packages/nano-runtime/src/runner/model-state.ts"
    import { loadRestSnapshot, loadSession } from "./packages/nano-runtime/src/runner/session.ts"
    import { __test, isRunning, isWaitingForEvent, wake, shutdown } from "./packages/nano-runtime/src/runner/index.ts"
    import { grepContext } from "./packages/nano-runtime/src/runner/context-store.ts"
    config.agent.boredom_wake_min = 0
    initDb()
    initMetricsDb()
    const requests = []
    ${childHelpers}
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      const body = JSON.parse(String(init.body))
      requests.push({ url, body, authorization: new Headers(init.headers).get('authorization') })
      if (url === 'https://old.fixture.invalid/v1/chat/completions' && body.messages.some(m => JSON.stringify(m).includes('[model swap handoff]'))) {
        return new Response('provider failure during outgoing handoff', { status: 503 })
      }
      if (url === 'https://new.fixture.invalid/v1/chat/completions') {
        return new Response(frame({ content: 'fresh selected session after archive' }, 'stop') + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      assert.equal(url, 'https://old.fixture.invalid/v1/chat/completions')
      return new Response(frame({ content: 'unexpected old provider request' }, 'stop') + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    const initial = wake({ source: 'chat', content: 'raw-failure-history-proof', triggeredAt: new Date().toISOString(), raw: null })
    await until(() => isRunning() && isWaitingForEvent())
    const outcome = await __test.requestModelSwap('next', ${JSON.stringify(testBounds)})
    assert.equal(outcome.graceful, false)
    assert.ok(outcome.fallbackReason)
    assert.equal(modelState.primaryModel?.id, 'new-model')
    assert.ok(requests.some(r => r.url === 'https://old.fixture.invalid/v1/chat/completions' && r.authorization === 'Bearer old-key'))
    assert.equal(requests.some(r => r.url === 'https://fallback.fixture.invalid/v1/chat/completions'), false, 'a journal/end failure stays on the outgoing provider instead of provider-failover')
    await until(() => requests.some(r => r.url === 'https://new.fixture.invalid/v1/chat/completions'))
    const fresh = requests.find(r => r.url === 'https://new.fixture.invalid/v1/chat/completions')
    assert.ok(fresh)
    assert.equal(fresh.authorization, 'Bearer new-key')
    assert.equal(fresh.body.messages.some(m => JSON.stringify(m).includes('raw-failure-history-proof')), false)
    const rest = await loadRestSnapshot('main', false)
    assert.ok(rest)
    assert.match(rest.summary, /context-summary-id/)
    const selectedSession = await loadSession('main')
    assert.ok(selectedSession)
    assert.equal(selectedSession.contextModelId, 'new-model')
    assert.equal(selectedSession.messages.some(m => JSON.stringify(m).includes('raw-failure-history-proof')), false)
    assert.ok(grepContext('raw-failure-history-proof').length > 0)
    await until(() => isWaitingForEvent())
    await shutdown()
    await initial
  `
  const failedClose = await runChild(failedCloseHome, fixtureConfig, failureScript)
  assert.equal(failedClose.code, 0, failedClose.output)
})

test("selected-phase restart replays identical queued events once by lane-specific receipt IDs", { timeout: 30_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-model-swap-receipts-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const seeded = await runChild(home, fixtureConfig, `
    import { createHash } from "node:crypto"
    import { saveSession, saveModelSwapHandoff } from "./packages/nano-runtime/src/runner/session.ts"
    import { persistModelSwap, resolveModelSwap } from "./packages/nano-runtime/src/runner/model-state.ts"
    await persistModelSwap(resolveModelSwap('next'))
    const event = { source: 'chat', content: 'identical-queued-work', triggeredAt: '2026-01-01T00:00:00.000Z', raw: null }
    const fingerprint = createHash('sha256').update('[]').digest('hex')
    for (const kind of ['main', 'frontend']) {
      await saveSession({ version: 1, messages: [{ role: 'user', content: event.content, timestamp: 1 }], toolCatalog: [], toolCatalogEpoch: 1, toolCatalogFingerprint: fingerprint, contextModelId: 'new-model', modelSwapHandoffId: kind + '-receipt', modelSwapEventIds: [kind + '-first'] }, kind)
    }
    await saveModelSwapHandoff({ version: 1, preset: 'next', phase: 'selected', id: 'main-receipt', eventIds: ['main-first', 'main-second'], messages: [], events: [event, event], frontendId: 'frontend-receipt', frontendEventIds: ['frontend-first', 'frontend-second'], frontendMessages: [], frontendEvents: [event, event], note: 'crash after the first replay batch was persisted' })
  `)
  assert.equal(seeded.code, 0, seeded.output)
  const recovered = await runChild(home, fixtureConfig, `
    import assert from "node:assert/strict"
    import { initDb } from "./packages/nano-runtime/src/db.ts"
    import { initMetricsDb } from "./packages/nano-runtime/src/metrics.ts"
    import { loadSession, loadModelSwapHandoff } from "./packages/nano-runtime/src/runner/session.ts"
    import { modelState } from "./packages/nano-runtime/src/runner/model-state.ts"
    import { recoverModelSwapHandoff } from "./packages/nano-runtime/src/runner/index.ts"
    initDb()
    initMetricsDb()
    globalThis.fetch = async () => assert.fail('recovery must not invoke a provider')
    await recoverModelSwapHandoff()
    await recoverModelSwapHandoff()
    assert.equal(modelState.primaryModel?.id, 'new-model')
    for (const kind of ['main', 'frontend']) {
      const session = await loadSession(kind)
      assert.ok(session)
      assert.equal(session.messages.filter(message => JSON.stringify(message.content).includes('identical-queued-work')).length, 2)
      assert.deepEqual(session.modelSwapEventIds, [kind + '-first', kind + '-second'])
    }
    assert.equal(await loadModelSwapHandoff(), null)
  `)
  assert.equal(recovered.code, 0, recovered.output)
})
