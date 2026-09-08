import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { setImmediate } from "node:timers/promises"
import test from "node:test"

test("boredom makes real model requests at startup, during waits, and after rest", async (t) => {
  const home = await mkdtemp("/tmp/nano-boredom-")
  process.env.NANO_HOME = home
  process.env.NANO_AGENT_STATE_DIR = `${home}/state`
  const { config } = await import("../config")
  config.agent.boredom_wake_min = 0.001 // 60ms, advanced with the fake clock
  const { initDb } = await import("../db")
  const { initMetricsDb } = await import("../metrics")
  initDb()
  initMetricsDb()
  const { modelState } = await import("./model-state")
  modelState.useFallback = true
  modelState.fallbackApiKey = "test"
  modelState.fallbackModel = { ...modelState.fallbackModel, baseUrl: "https://model.invalid/v1" }
  modelState.primaryNudgeOnNoTool = false
  modelState.compactionStrategy = "off"
  modelState.idleCompactionMs = 0
  const runner = await import("./index")
  const requests: any[] = []
  let nextTool: "wait" | "wait_then_continue" | undefined
  let releaseRequest: (() => void) | undefined
  let holdRequest = false
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    requests.push(body)
    if (holdRequest) await new Promise<void>((resolve) => { releaseRequest = resolve })
    const tool = nextTool
    nextTool = undefined
    const delta = tool
      ? { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: tool, arguments: tool === "wait" ? "{}" : '{"timeout_ms":1000}' } }] }
      : { content: "nothing pending" }
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  })
  async function until(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 10_000; i++) {
      if (predicate()) return
      await setImmediate()
    }
    assert.fail("runner did not reach the expected state")
  }
  t.after(async () => {
    holdRequest = false
    releaseRequest?.()
    if (runner.isRunning()) {
      runner.requestRest("test cleanup")
      await until(() => !runner.isRunning())
    }
    await runner.shutdown()
    await rm(home, { recursive: true, force: true })
  })
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 })

  runner.startBoredomTimer()
  t.mock.timers.tick(59)
  assert.equal(requests.length, 0)
  t.mock.timers.tick(1)
  await until(() => requests.length === 1 && runner.isWaitingForEvent())
  assert.match(JSON.stringify(requests[0].messages), /\[boredom\]/)

  // An ordinary event interrupts waiting and resets the full quiet interval.
  t.mock.timers.tick(40)
  runner.activate({ source: "chat", content: "hello", triggeredAt: new Date().toISOString(), raw: null })
  await until(() => requests.length === 2 && runner.isWaitingForEvent())
  t.mock.timers.tick(59)
  assert.equal(requests.length, 2)
  nextTool = "wait"
  t.mock.timers.tick(1)
  await until(() => requests.length === 3 && runner.isWaitingForEvent())
  assert.ok(requests[2].messages.length > requests[0].messages.length, "resume the existing context")

  // Both explicit wait tools must be interruptible by boredom.
  nextTool = "wait_then_continue"
  t.mock.timers.tick(60)
  await until(() => requests.length === 4 && runner.isWaitingForEvent())
  holdRequest = true
  t.mock.timers.tick(60)
  await until(() => requests.length === 5 && releaseRequest !== undefined)
  t.mock.timers.tick(600)
  assert.equal(requests.length, 5, "do not activate while a model request is in flight")
  holdRequest = false
  releaseRequest!()
  await until(() => runner.isWaitingForEvent())
  runner.requestRest("test rest")
  await until(() => !runner.isRunning())

  t.mock.timers.tick(60)
  await until(() => requests.length === 6 && runner.isWaitingForEvent())
  runner.requestRest("test queued input")
  await until(() => !runner.isRunning())
  runner.enqueueEvent({ source: "chat", content: "queued while resting", triggeredAt: new Date().toISOString(), raw: null })
  t.mock.timers.tick(60)
  await until(() => requests.length === 7 && runner.isWaitingForEvent())
  assert.match(JSON.stringify(requests[6].messages.at(-1)), /queued while resting/)
  runner.requestRest("test shutdown while resting")
  await until(() => !runner.isRunning())
  await runner.shutdown()
  runner.startBoredomTimer()
  t.mock.timers.tick(600)
  await setImmediate()
  assert.equal(requests.length, 7, "shutdown must cancel and disable boredom")
})
