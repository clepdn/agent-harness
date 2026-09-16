import assert from "node:assert/strict"
import test from "node:test"
import {
  configureDiscordTyping,
  dispatchDiscordTyping,
  notifyDiscordModelActivity,
  beginDiscordToolWait,
  endDiscordToolWait,
  stopDiscordTyping,
  shouldSendDiscordTyping,
  __discordTypingLeaseTest,
} from "./typing-lease"

test("outbound typing is limited to Discord DMs", () => {
  assert.equal(shouldSendDiscordTyping({ type: 1 }), true)
  assert.equal(shouldSendDiscordTyping({ type: 3 }), true)
  assert.equal(shouldSendDiscordTyping({ type: 0 }), false)
  assert.equal(shouldSendDiscordTyping({ type: 11 }), false)
  assert.equal(shouldSendDiscordTyping(null), false)
})

test("typing lease starts on model activity and refreshes", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] })
  const sends: string[] = []
  configureDiscordTyping((channelId) => { sends.push(channelId) })
  try {
    dispatchDiscordTyping("turn-1", "channel-1")
    t.mock.timers.tick(__discordTypingLeaseTest.fallbackMs - 1)
    assert.deepEqual(sends, [])
    notifyDiscordModelActivity("turn-1")
    assert.deepEqual(sends, ["channel-1"])
    t.mock.timers.tick(__discordTypingLeaseTest.refreshMs)
    assert.deepEqual(sends, ["channel-1", "channel-1"])
  } finally {
    __discordTypingLeaseTest.reset()
  }
})

test("stale turn cannot start or stop a superseding lease", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] })
  let sends = 0
  configureDiscordTyping(() => { sends++ })
  try {
    dispatchDiscordTyping("old", "old-channel")
    dispatchDiscordTyping("new", "new-channel")
    notifyDiscordModelActivity("old")
    t.mock.timers.tick(__discordTypingLeaseTest.fallbackMs)
    assert.equal(sends, 1)
    stopDiscordTyping("old")
    t.mock.timers.tick(__discordTypingLeaseTest.refreshMs)
    assert.equal(sends, 2)
  } finally {
    __discordTypingLeaseTest.reset()
  }
})

test("long tool wait pauses refresh and resumes after tool", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] })
  let sends = 0
  configureDiscordTyping(() => { sends++ })
  try {
    dispatchDiscordTyping("turn-2", "channel-2")
    notifyDiscordModelActivity("turn-2")
    beginDiscordToolWait("turn-2")
    t.mock.timers.tick(__discordTypingLeaseTest.longToolWaitMs - 1)
    assert.equal(sends, 3)
    t.mock.timers.tick(1)
    t.mock.timers.tick(__discordTypingLeaseTest.refreshMs)
    assert.equal(sends, 3)
    endDiscordToolWait("turn-2")
    assert.equal(sends, 4)
  } finally {
    __discordTypingLeaseTest.reset()
  }
})

test("stop synchronously cancels fallback and refresh timers", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] })
  let sends = 0
  configureDiscordTyping(() => { sends++ })
  try {
    dispatchDiscordTyping("turn-3", "channel-3")
    stopDiscordTyping("turn-3")
    t.mock.timers.tick(__discordTypingLeaseTest.fallbackMs + __discordTypingLeaseTest.refreshMs)
    assert.equal(sends, 0)
  } finally {
    __discordTypingLeaseTest.reset()
  }
})
