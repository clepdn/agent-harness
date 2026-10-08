import assert from "node:assert/strict"
import test from "node:test"
import { createBoredomTimer } from "./boredom-timer"

test("boredom stays disabled for non-positive or invalid intervals", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  for (const delay of [0, -1, NaN, Infinity]) {
    const timer = createBoredomTimer(delay, () => assert.fail("unexpected activation"))
    timer.idle()
  }
  t.mock.timers.tick(100_000)
})

test("activity resets boredom while idle compaction preserves the quiet deadline", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  let activations = 0
  const timer = createBoredomTimer(100, () => { activations++ })
  t.after(() => timer.stop())
  timer.idle()
  t.mock.timers.tick(60)
  timer.active()
  t.mock.timers.tick(200)
  assert.equal(activations, 0, "busy work must not activate the model")
  timer.idle()
  t.mock.timers.tick(60)
  timer.pause()
  t.mock.timers.tick(20)
  timer.idle()
  timer.idle()
  t.mock.timers.tick(19)
  assert.equal(activations, 0)
  t.mock.timers.tick(1)
  assert.equal(activations, 1)
  t.mock.timers.tick(1000)
  assert.equal(activations, 1, "one event per idle interval")
})

test("overdue boredom waits for compaction to finish, and shutdown prevents rearming", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  let activations = 0
  const timer = createBoredomTimer(100, () => { activations++ })
  timer.idle()
  t.mock.timers.tick(50)
  timer.pause()
  t.mock.timers.tick(200)
  assert.equal(activations, 0)
  timer.idle()
  t.mock.timers.tick(1)
  assert.equal(activations, 1)
  timer.idle()
  timer.stop()
  timer.idle()
  t.mock.timers.tick(1000)
  assert.equal(activations, 1)
})
