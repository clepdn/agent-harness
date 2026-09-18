import assert from "node:assert/strict"
import test from "node:test"
import { config } from "../config"
import {
  configureDiscordTyping,
  dispatchDiscordTyping,
  notifyDiscordModelActivity,
  beginDiscordToolWait,
  endDiscordToolWait,
  stopDiscordTyping,
  __discordTypingLeaseTest,
} from "./typing-lease"

test("Discord typing is enabled by default", () => {
  assert.equal(config.discord.typing_enabled, true)
})

test("disabled typing does not create a lease", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] })
  let sends = 0
  configureDiscordTyping(() => { sends++ }, false)
  try {
    dispatchDiscordTyping("turn-disabled", "channel-disabled")
    notifyDiscordModelActivity("turn-disabled")
    t.mock.timers.tick(__discordTypingLeaseTest.refreshMs * 2)
    assert.equal(sends, 0)
  } finally {
    __discordTypingLeaseTest.reset()
  }
})

test("typing lease starts on model activity and refreshes", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] })
  const sends: string[] = []
  configureDiscordTyping((channelId) => { sends.push(channelId) })
  try {
    dispatchDiscordTyping("turn-1", "channel-1")
    t.mock.timers.tick(__discordTypingLeaseTest.refreshMs * 2)
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
    assert.equal(sends, 0)
    notifyDiscordModelActivity("new")
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

test("stop synchronously cancels refresh timers", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] })
  let sends = 0
  configureDiscordTyping(() => { sends++ })
  try {
    dispatchDiscordTyping("turn-3", "channel-3")
    notifyDiscordModelActivity("turn-3")
    stopDiscordTyping("turn-3")
    t.mock.timers.tick(__discordTypingLeaseTest.refreshMs * 2)
    assert.equal(sends, 1)
  } finally {
    __discordTypingLeaseTest.reset()
  }
})
