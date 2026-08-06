import assert from "node:assert/strict"
import test from "node:test"
import { config } from "../config"
import { debounceDmWake, noteDmTyping, _resetDmDebounce } from "./dm-debounce"

type DiscordCfg = { dm_wake_debounce_ms: number; dm_wake_debounce_cap_ms: number }

function withCfg(base: number, cap: number, run: () => void): void {
  const d = config.discord as unknown as DiscordCfg
  const ob = d.dm_wake_debounce_ms
  const oc = d.dm_wake_debounce_cap_ms
  d.dm_wake_debounce_ms = base
  d.dm_wake_debounce_cap_ms = cap
  try {
    _resetDmDebounce()
    run()
  } finally {
    _resetDmDebounce()
    d.dm_wake_debounce_ms = ob
    d.dm_wake_debounce_cap_ms = oc
  }
}

test("dm wake fires after base delay when idle", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  withCfg(5000, 60000, () => {
    let fired = 0
    const deferred = debounceDmWake("chanA", () => { fired++ })
    assert.equal(deferred, true, "wake should be deferred")
    t.mock.timers.tick(4999)
    assert.equal(fired, 0, "should not fire before base delay")
    t.mock.timers.tick(2)
    assert.equal(fired, 1, "should fire once after base delay")
  })
})

test("typing extends the window", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  withCfg(5000, 60000, () => {
    let fired = 0
    debounceDmWake("chanB", () => { fired++ })
    t.mock.timers.tick(4000)
    noteDmTyping("chanB")          // reset to now + 5000
    t.mock.timers.tick(4000)
    assert.equal(fired, 0, "typing should have pushed the fire out")
    t.mock.timers.tick(1001)
    assert.equal(fired, 1, "fires 5s after last typing signal")
  })
})

test("follow-up messages extend, latest fire callback wins", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  withCfg(5000, 60000, () => {
    const order: string[] = []
    debounceDmWake("chanC", () => order.push("first"))
    t.mock.timers.tick(3000)
    debounceDmWake("chanC", () => order.push("second"))
    t.mock.timers.tick(5001)
    assert.deepEqual(order, ["second"], "only latest callback fires, once")
  })
})

test("cap bounds total hold even with continuous typing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  withCfg(5000, 60000, () => {
    let fired = 0
    debounceDmWake("chanD", () => { fired++ })
    // Type every 3s for a long time; without a cap this never fires.
    for (let elapsed = 0; elapsed < 90000; elapsed += 3000) {
      t.mock.timers.tick(3000)
      noteDmTyping("chanD")
    }
    assert.equal(fired, 1, "cap should have forced a single fire by 60s")
  })
})

test("disabled when base delay is zero", () => {
  withCfg(0, 60000, () => {
    let fired = 0
    const deferred = debounceDmWake("chanE", () => { fired++ })
    assert.equal(deferred, false, "should not defer when disabled")
    assert.equal(fired, 0, "caller handles the wake, debouncer stays out")
  })
})
