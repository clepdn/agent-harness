import assert from "node:assert/strict"
import test from "node:test"
import { createDiscordTypingLease } from "./typing-lease"

const REFRESH_MS = 8_000
const LONG_TOOL_WAIT_MS = 20_000


test("Discord typing is enabled by default", () => {
  const sends: string[] = []
  const typing = createDiscordTypingLease((channelId) => { sends.push(channelId) })
  typing.dispatch("turn", "channel")
  typing.notify("turn")
  assert.deepEqual(sends, ["channel"])
  typing.reset()
})

test("disabled typing does not create a lease", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] })
  let sends = 0
  const typing = createDiscordTypingLease(() => { sends++ }, false)
  typing.dispatch("turn-disabled", "channel-disabled")
  try {
    typing.notify("turn-disabled")
    t.mock.timers.tick(REFRESH_MS * 2)
    assert.equal(sends, 0)
  } finally {
    typing.reset()
  }
})

test("typing lease starts on model activity and refreshes", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] })
  const sends: string[] = []
  const typing = createDiscordTypingLease((channelId) => { sends.push(channelId) })
  try {
    typing.dispatch("turn-1", "channel-1")
    t.mock.timers.tick(REFRESH_MS * 2)
    assert.deepEqual(sends, [])
    typing.notify("turn-1")
    assert.deepEqual(sends, ["channel-1"])
    t.mock.timers.tick(REFRESH_MS)
    assert.deepEqual(sends, ["channel-1", "channel-1"])
  } finally {
    typing.reset()
  }
})

test("stale turn cannot start or stop a superseding lease", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] })
  let sends = 0
  const typing = createDiscordTypingLease(() => { sends++ })
  try {
    typing.dispatch("old", "old-channel")
    typing.dispatch("new", "new-channel")
    typing.notify("old")
    assert.equal(sends, 0)
    typing.notify("new")
    assert.equal(sends, 1)
    typing.stop("old")
    t.mock.timers.tick(REFRESH_MS)
    assert.equal(sends, 2)
  } finally {
    typing.reset()
  }
})

test("long tool wait pauses refresh and resumes after tool", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] })
  let sends = 0
  const typing = createDiscordTypingLease(() => { sends++ })
  try {
    typing.dispatch("turn-2", "channel-2")
    typing.notify("turn-2")
    typing.beginToolWait("turn-2")
    t.mock.timers.tick(LONG_TOOL_WAIT_MS - 1)
    assert.equal(sends, 3)
    t.mock.timers.tick(1)
    t.mock.timers.tick(REFRESH_MS)
    assert.equal(sends, 3)
    typing.endToolWait("turn-2")
    assert.equal(sends, 4)
  } finally {
    typing.reset()
  }
})

test("stop synchronously cancels refresh timers", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] })
  let sends = 0
  const typing = createDiscordTypingLease(() => { sends++ })
  try {
    typing.dispatch("turn-3", "channel-3")
    typing.notify("turn-3")
    typing.stop("turn-3")
    t.mock.timers.tick(REFRESH_MS * 2)
    assert.equal(sends, 1)
  } finally {
    typing.reset()
  }
})
