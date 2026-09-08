import assert from "node:assert/strict"
import test from "node:test"
import { __loopTest } from "./loop"
import { __loopToolsTest } from "./loop-tools"
import { modelState } from "./model-state"
import type { Message, UserMessage } from "../types"
import type { LoopState } from "./types"
import { makeUserMessage, makeAssistantMessage, makeToolResultMessage } from "./test-helpers"
import {
  configureDiscordTyping,
  dispatchDiscordTyping,
  notifyDiscordModelActivity,
  __discordTypingLeaseTest,
} from "../discord/typing-lease"

const testClientTools = {
  getCapabilities: () => [],
  getWorkspace: () => null,
  execute: async () => {
    throw new Error("unexpected client tool execution")
  },
}

function makeState(): LoopState {
  return {
    systemPrompt: "",
    conversation: [],
    pendingInputs: [],
    tokenCount: 0,
    contextSize: 0,
    toolCatalog: [],
    toolInFlight: false,
    toolCatalogEpoch: 1,
    toolCatalogFingerprint: "",
    memoryRecallCooldowns: {},
    memoryRecallTurn: 0,
    memoryRecallPending: false,
    shutdownRequested: false,
    turnInFlight: false,
    restRequested: false,
    restReason: "",
  }
}

test("pendingDiscordChannel selects newest Discord wake in the pending user segment", () => {
  const conversation = [
    makeUserMessage("[discord/dm] old context: DM old-channel"),
    makeAssistantMessage("handled"),
    makeUserMessage("[discord/dm] new context: DM new-channel"),
  ]
  assert.equal(__loopTest.pendingDiscordChannel(conversation, conversation.length), "new-channel")
})

test("pendingDiscordChannel ignores stale Discord context before the prior assistant", () => {
  const conversation = [
    makeUserMessage("[discord/dm] stale context: DM stale-channel"),
    makeAssistantMessage("handled"),
    makeUserMessage("ordinary user message"),
  ]
  assert.equal(__loopTest.pendingDiscordChannel(conversation, conversation.length), undefined)
})

function makeTypingSupersessionHooks(state: LoopState, injected: UserMessage[]) {
  return {
    injectIncomingEvent: (_convId: number, event: UserMessage) => {
      injected.push(event)
      state.conversation.push(makeUserMessage(`[incoming — ${event.source}]\n\n${event.content}`))
    },
  } as never
}

test("new Discord event stops typing for the superseded turn", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] })
  const state = makeState()
  const injected: UserMessage[] = []
  const typingChannels: string[] = []
  state.discordTypingTurnId = "old-turn"
  state.discordTypingChannelId = "old-channel"
  configureDiscordTyping((channelId) => { typingChannels.push(channelId) })
  dispatchDiscordTyping("old-turn", "old-channel")
  notifyDiscordModelActivity("old-turn")
  state.pendingInputs.push({
    source: "discord",
    triggeredAt: "2026-08-28T00:00:00.000Z",
    content: "[discord/dm] @alice\ncontext: DM new-channel\n\nnew message",
    raw: {},
  })

  try {
    assert.equal(__loopToolsTest.maybeInterruptAfterTool(1, state, makeTypingSupersessionHooks(state, injected), [], 0), true)
    assert.equal(injected[0]?.source, "discord")
    assert.equal(__loopTest.pendingDiscordChannel(state.conversation, state.conversation.length), "new-channel")
    t.mock.timers.tick(__discordTypingLeaseTest.fallbackMs + __discordTypingLeaseTest.refreshMs)
    assert.deepEqual(typingChannels, ["old-channel"])
  } finally {
    __discordTypingLeaseTest.reset()
  }
})

test("new non-Discord event stops typing for the superseded Discord turn", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] })
  const state = makeState()
  const injected: UserMessage[] = []
  const typingChannels: string[] = []
  state.discordTypingTurnId = "old-turn"
  state.discordTypingChannelId = "old-channel"
  configureDiscordTyping((channelId) => { typingChannels.push(channelId) })
  dispatchDiscordTyping("old-turn", "old-channel")
  notifyDiscordModelActivity("old-turn")
  state.pendingInputs.push({
    source: "chat",
    triggeredAt: "2026-08-28T00:00:00.000Z",
    content: "hello from chat",
    raw: {},
  })

  try {
    assert.equal(__loopToolsTest.maybeInterruptAfterTool(1, state, makeTypingSupersessionHooks(state, injected), [], 0), true)
    assert.equal(injected[0]?.source, "chat")
    assert.equal(__loopTest.pendingDiscordChannel(state.conversation, state.conversation.length), undefined)
    t.mock.timers.tick(__discordTypingLeaseTest.fallbackMs + __discordTypingLeaseTest.refreshMs)
    assert.deepEqual(typingChannels, ["old-channel"])
  } finally {
    __discordTypingLeaseTest.reset()
  }
})

test("applyDiscordSendNudge appends a follow-up user nudge for unsent Discord replies", () => {
  const state = makeState()
  const turnMessages: Message[] = [
    makeUserMessage("[user/discord] [discord/dm] hey are you there"),
    makeAssistantMessage("yeah, i'm here"),
  ]

  const nudged = __loopTest.applyDiscordSendNudge(state, turnMessages)

  assert.equal(nudged, true)
  assert.equal(state.conversation.length, 1)
  assert.match(String(state.conversation[0]?.content), /did not call discord_send/i)
})

test("applyDiscordSendNudge fires for [discord batch] envelopes (space, not slash)", () => {
  const state = makeState()
  const turnMessages: Message[] = [
    makeUserMessage("[user/discord] [discord batch] 2026-05-01T03:10:50.162Z -> 2026-05-01T03:11:22.198Z\n@meowskullz: hi\n@meowskullz: u there"),
    makeAssistantMessage("yeah hi"),
  ]

  const nudged = __loopTest.applyDiscordSendNudge(state, turnMessages)

  assert.equal(nudged, true)
  assert.equal(state.conversation.length, 1)
  assert.match(String(state.conversation[0]?.content), /did not call discord_send/i)
})

test("applyDiscordSendNudge fires after a harness restart when the discord event is pre-turn context", () => {
  const state = makeState()
  state.conversation.push(
    makeUserMessage("[harness restarted — discord @ 2026-05-01T04:30:00.000Z]\n\n[discord/dm] hi starfish"),
    makeAssistantMessage("i keep getting bounced by harness restarts sorry ^^ still here though! what's up?"),
  )

  const turnMessages: Message[] = [state.conversation[1]!]

  const nudged = __loopTest.applyDiscordSendNudge(state, turnMessages, 1)

  assert.equal(nudged, true)
  assert.equal(state.conversation.length, 3)
  assert.match(String(state.conversation[2]?.content), /did not call discord_send/i)
})

test("applyDiscordSendNudge does not fire when discord_send was already called", () => {
  const state = makeState()
  const turnMessages: Message[] = [
    makeUserMessage("[user/discord] [discord/channel] can you reply"),
    makeAssistantMessage("sending now", {
      content: [
        { type: "text", text: "sending now" },
        {
          type: "toolCall",
          id: "call_123",
          name: "discord_send",
          arguments: { channel_id: "1", content: "sending now" },
        },
      ],
    }),
  ]

  const nudged = __loopTest.applyDiscordSendNudge(state, turnMessages)

  assert.equal(nudged, false)
  assert.equal(state.conversation.length, 0)
})

test("applyDiscordSendNudge keeps a wake DM active across a preliminary tool step", () => {
  const state = makeState()
  state.conversation.push(
    makeUserMessage("[wake] 7/14/2026, 3:22:59 AM — triggered by discord\n\n[discord/dm] @meowskullz\n\nboop"),
    makeAssistantMessage("", {
      content: [{ type: "toolCall", id: "call_memory", name: "memory_read", arguments: { path: "wake.md" } }],
    }),
    makeToolResultMessage("call_memory", "test", "wake notes"),
    makeAssistantMessage("hey you ^.^"),
  )

  const nudged = __loopTest.applyDiscordSendNudge(state, state.conversation.slice(1), 1)

  assert.equal(nudged, true)
  assert.match(String(state.conversation[4]?.content), /did not call discord_send/i)
})

test("applyDiscordSendNudge sees discord_send from an earlier tool step in the active user turn", () => {
  const state = makeState()
  state.conversation.push(
    makeUserMessage("[wake] 7/14/2026, 3:22:59 AM — triggered by discord\n\n[discord/dm] @meowskullz\n\nboop"),
    makeAssistantMessage("", {
      content: [{ type: "toolCall", id: "call_send", name: "discord_send", arguments: { source_item_id: "1", content: "boop" } }],
    }),
    makeToolResultMessage("call_send", "test", "sent!"),
    makeAssistantMessage("okay, delivered"),
  )

  const nudged = __loopTest.applyDiscordSendNudge(state, state.conversation.slice(1), 1)

  assert.equal(nudged, false)
  assert.equal(state.conversation.length, 4)
})

test("applyLoopGuardNudge appends an in-band user nudge", async () => {
  const state = makeState()
  let saved = false

  await __loopTest.applyLoopGuardNudge(
    state,
    {
      clientTools: testClientTools,
      refreshToolCatalog: () => {},
      waitForEvent: async () => {
        throw new Error("unexpected wait")
      },
      waitForEventWithTimeout: async () => null,
      injectIncomingEvent: () => {},
      flushDeferredEvents: () => {},
      clearSession: async () => {},
      saveSession: async () => {
        saved = true
      },
      saveShutdownSnapshot: async () => {},
      shouldShutdown: () => false,
      resolveShutdown: () => {},
    },
    "loop guard tripped after 120 turns",
  )

  // Persistence is deliberately deferred: the nudge lands in-band and is
  // written out later by the rest snapshot, not by applyLoopGuardNudge.
  assert.equal(saved, false)
  assert.equal(state.conversation.length, 1)
  assert.equal(state.conversation[0]?.role, "user")
  assert.match(String(state.conversation[0]?.content), /loop guard tripped after 120 turns/i)
})

test("waitForNextEvent waits for and injects the next external event", async () => {
  const calls: string[] = []
  const event = {
    source: "chat" as const,
    triggeredAt: "2026-05-01T04:40:00.000Z",
    content: "still here",
    raw: {},
  }

  // Idle compaction defaults on (45min) in the test config, so the wait uses
  // the timeout variant. Return the event immediately to exercise the inject.
  await __loopTest.waitForNextEvent(42, makeState(), {
    clientTools: testClientTools,
    refreshToolCatalog: () => {},
    waitForEvent: async () => {
      calls.push("wait")
      return event
    },
    waitForEventWithTimeout: async () => {
      calls.push("wait")
      return event
    },
    injectIncomingEvent: (_convId, incoming) => {
      calls.push(`inject:${incoming.content}`)
      assert.equal(_convId, 42)
      assert.equal(incoming, event)
    },
    flushDeferredEvents: () => {},
    clearSession: async () => {},
    saveSession: async () => {},
    saveShutdownSnapshot: async () => {},
    shouldShutdown: () => false,
    resolveShutdown: () => {},
  })

  assert.deepEqual(calls, ["wait", "inject:still here"])
})

test("waitForNextEvent returns after successful compaction for immediate reactivation", async () => {
  const calls: string[] = []
  const state = makeState()
  const savedIdle = modelState.idleCompactionMs
  modelState.idleCompactionMs = 60_000

  try {
    await __loopTest.waitForNextEvent(7, state, {
      clientTools: testClientTools,
      refreshToolCatalog: () => {},
      waitForEvent: async () => {
        calls.push("wait")
        return null
      },
      waitForEventWithTimeout: async () => {
        calls.push("timeout")
        return null
      },
      injectIncomingEvent: () => calls.push("inject"),
      flushDeferredEvents: () => {},
      clearSession: async () => {},
      saveSession: async () => {},
      saveShutdownSnapshot: async () => {},
      shouldShutdown: () => false,
      resolveShutdown: () => {},
    }, async () => {
      calls.push("compact")
      return "rewritten"
    })
  } finally {
    modelState.idleCompactionMs = savedIdle
  }

  assert.deepEqual(calls, ["timeout", "compact"])
})

test("waitForNextEvent bails out on shutdown instead of looping the idle timer", async () => {
  const calls: string[] = []
  let shuttingDown = false

  // Idle compaction is a per-preset option that defaults to 0 (off). Enable it
  // here so waitForNextEvent takes the idle-timeout branch this test exercises.
  const savedIdle = modelState.idleCompactionMs
  modelState.idleCompactionMs = 60_000

  await __loopTest.waitForNextEvent(7, makeState(), {
    clientTools: testClientTools,
    refreshToolCatalog: () => {},
    waitForEvent: async () => null,
    // First timeout returns null (no event); the loop should then see shutdown
    // and return without ever injecting or looping again.
    waitForEventWithTimeout: async () => {
      calls.push("timeout")
      shuttingDown = true
      return null
    },
    injectIncomingEvent: () => {
      calls.push("inject")
    },
    flushDeferredEvents: () => {},
    clearSession: async () => {},
    saveSession: async () => {},
    saveShutdownSnapshot: async () => {},
    shouldShutdown: () => shuttingDown,
    resolveShutdown: () => {},
  })

  modelState.idleCompactionMs = savedIdle

  // Exactly one timeout, no inject, no infinite loop.
  assert.deepEqual(calls, ["timeout"])
})

test("waitForNextEvent clears a manual compaction request after running the idle pass", async () => {
  const savedIdle = modelState.idleCompactionMs
  modelState.idleCompactionMs = 60_000

  const state = makeState()
  state.compactionRequested = true
  // Below any trigger — idle compaction must still attempt regardless.
  state.contextSize = 0

  let shuttingDown = false
  let timeouts = 0
  await __loopTest.waitForNextEvent(9, state, {
    clientTools: testClientTools,
    refreshToolCatalog: () => {},
    waitForEvent: async () => null,
    // First "timeout" (interrupt) returns null with the flag set; the loop
    // clears the flag and runs the idle pass, then loops. On the second
    // iteration we shut down so the loop exits. This proves the pass ran and
    // cleared the flag before exit.
    waitForEventWithTimeout: async () => {
      timeouts += 1
      if (timeouts === 1) {
        assert.equal(state.compactionRequested, true, "flag should still be set before the first pass")
      } else {
        shuttingDown = true
      }
      return null
    },
    injectIncomingEvent: () => {},
    flushDeferredEvents: () => {},
    clearSession: async () => {},
    saveSession: async () => {},
    saveShutdownSnapshot: async () => {},
    shouldShutdown: () => shuttingDown,
    resolveShutdown: () => {},
  })

  modelState.idleCompactionMs = savedIdle

  // The manual flag is cleared once the pass has run.
  assert.equal(state.compactionRequested, false)
})

test("applyCompaction attempts an idle burn even below the token trigger", async () => {
  const savedStrategy = modelState.compactionStrategy
  const savedTrigger = modelState.compactTriggerTokens
  // companion normally no-ops below trigger; idle must force through anyway.
  modelState.compactionStrategy = "companion"
  modelState.compactTriggerTokens = 100_000

  const state = makeState()
  state.contextSize = 1_000 // well below trigger
  state.conversation = [
    makeUserMessage("hello"),
    makeAssistantMessage("hi there"),
  ]

  const result = await __loopTest.applyCompaction(state, "idle")
  assert.equal(result, "none")

  modelState.compactionStrategy = savedStrategy
  modelState.compactTriggerTokens = savedTrigger
})
