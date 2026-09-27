import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { __loopTest } from "./loop"
import { __loopToolsTest, processToolCalls } from "./loop-tools"
import { modelState } from "./model-state"
import { fallbackModel } from "./config"
import type { Message, UserMessage } from "../types"
import type { LoopHooks, LoopState } from "./types"
import { makeUserMessage, makeAssistantMessage, makeToolResultMessage } from "./test-helpers"
import {
  configureDiscordTyping,
  dispatchDiscordTyping,
  notifyDiscordModelActivity,
  __discordTypingLeaseTest,
} from "../discord/typing-lease"
import { initDb, startConversation } from "../db"
import { Context } from "../llm"

const testClientTools = {
  getCapabilities: () => [],
  getWorkspace: () => null,
  execute: async () => {
    throw new Error("unexpected client tool execution")
  },
}

function makeState(): LoopState {
  return {
    context: new Context({ model: fallbackModel }),
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
      state.context.append(makeUserMessage(`[incoming — ${event.source}]\n\n${event.content}`))
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
    assert.equal(__loopTest.pendingDiscordChannel(state.context.items, state.context.items.length), "new-channel")
    t.mock.timers.tick(__discordTypingLeaseTest.refreshMs * 2)
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
    assert.equal(__loopTest.pendingDiscordChannel(state.context.items, state.context.items.length), undefined)
    t.mock.timers.tick(__discordTypingLeaseTest.refreshMs * 2)
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
  assert.equal(state.context.items.length, 1)
  assert.match(String(state.context.items[0]?.content), /did not call discord_send/i)
})

test("applyDiscordSendNudge fires for [discord batch] envelopes (space, not slash)", () => {
  const state = makeState()
  const turnMessages: Message[] = [
    makeUserMessage("[user/discord] [discord batch] 2026-05-01T03:10:50.162Z -> 2026-05-01T03:11:22.198Z\n@meowskullz: hi\n@meowskullz: u there"),
    makeAssistantMessage("yeah hi"),
  ]

  const nudged = __loopTest.applyDiscordSendNudge(state, turnMessages)

  assert.equal(nudged, true)
  assert.equal(state.context.items.length, 1)
  assert.match(String(state.context.items[0]?.content), /did not call discord_send/i)
})

test("applyDiscordSendNudge fires after a harness restart when the discord event is pre-turn context", () => {
  const state = makeState()
  state.context.append(
    makeUserMessage("[harness restarted — discord @ 2026-05-01T04:30:00.000Z]\n\n[discord/dm] hi starfish"),
    makeAssistantMessage("i keep getting bounced by harness restarts sorry ^^ still here though! what's up?"),
  )

  const turnMessages: Message[] = [state.context.items[1]!]

  const nudged = __loopTest.applyDiscordSendNudge(state, turnMessages, 1)

  assert.equal(nudged, true)
  assert.equal(state.context.items.length, 3)
  assert.match(String(state.context.items[2]?.content), /did not call discord_send/i)
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
  assert.equal(state.context.items.length, 0)
})

test("applyDiscordSendNudge keeps a wake DM active across a preliminary tool step", () => {
  const state = makeState()
  state.context.append(
    makeUserMessage("[wake] 7/14/2026, 3:22:59 AM — triggered by discord\n\n[discord/dm] @meowskullz\n\nboop"),
    makeAssistantMessage("", {
      content: [{ type: "toolCall", id: "call_memory", name: "memory_read", arguments: { path: "wake.md" } }],
    }),
    makeToolResultMessage("call_memory", "test", "wake notes"),
    makeAssistantMessage("hey you ^.^"),
  )

  const nudged = __loopTest.applyDiscordSendNudge(state, state.context.items.slice(1), 1)

  assert.equal(nudged, true)
  assert.match(String(state.context.items[4]?.content), /did not call discord_send/i)
})

test("applyDiscordSendNudge sees discord_send from an earlier tool step in the active user turn", () => {
  const state = makeState()
  state.context.append(
    makeUserMessage("[wake] 7/14/2026, 3:22:59 AM — triggered by discord\n\n[discord/dm] @meowskullz\n\nboop"),
    makeAssistantMessage("", {
      content: [{ type: "toolCall", id: "call_send", name: "discord_send", arguments: { source_item_id: "1", content: "boop" } }],
    }),
    makeToolResultMessage("call_send", "test", "sent!"),
    makeAssistantMessage("okay, delivered"),
  )

  const nudged = __loopTest.applyDiscordSendNudge(state, state.context.items.slice(1), 1)

  assert.equal(nudged, false)
  assert.equal(state.context.items.length, 4)
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
  assert.equal(state.context.items.length, 1)
  assert.equal(state.context.items[0]?.role, "user")
  assert.match(String(state.context.items[0]?.content), /loop guard tripped after 120 turns/i)
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

test("wait tool yields to the runner idle wait instead of blocking on the raw event hook", async () => {
  initDb(":memory:")
  const convId = startConversation("test", new Date().toISOString())
  const state = makeState()
  state.toolCatalog = [{
    type: "function",
    function: { name: "wait", description: "wait", parameters: { type: "object", properties: {} } },
  }]
  let rawWaitCalls = 0

  const outcome = await processToolCalls(convId, state, {
    clientTools: testClientTools,
    refreshToolCatalog: () => {},
    waitForEvent: async () => {
      rawWaitCalls += 1
      return null
    },
    waitForEventWithTimeout: async () => {
      throw new Error("wait handler must leave timeout selection to waitForNextEvent")
    },
    injectIncomingEvent: () => {},
    flushDeferredEvents: () => {},
    clearSession: async () => {},
    saveSession: async () => {},
    saveShutdownSnapshot: async () => {},
    shouldShutdown: () => false,
    resolveShutdown: () => {},
  }, [{ type: "toolCall", id: "call_wait", name: "wait", arguments: {} }])

  assert.equal(outcome, "wait")
  assert.equal(rawWaitCalls, 0)
  assert.equal(state.context.items.at(-1)?.role, "toolResult")
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

async function makeCacheBudgetState(t: TestContext): Promise<LoopState> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const saved = { ...modelState }
  t.after(() => Object.assign(modelState, saved))
  Object.assign(modelState, {
    cacheWarming: true,
    cacheWarmingDurationMs: 315 * 60_000,
    cacheLifetimeMs: 30 * 60_000,
    useFallback: false,
    compactionStrategy: "companion",
    idleCompactionMs: 28 * 60_000,
  })
  t.mock.method(globalThis, "fetch", async () => Response.json({
    choices: [{ index: 0, message: { role: "assistant", content: "ready" }, finish_reason: "stop" }],
  }))
  const state = makeState()
  state.context = new Context({
    model: { ...fallbackModel, api: "openai-completions", provider: "openai", baseUrl: "https://cache-budget.invalid/v1" },
    apiKey: "test",
    items: [makeUserMessage("hello")],
  })
  await state.context.complete({ captureCacheWarmRequest: true })
  assert.equal(state.context.lastCompletionAt, 0)
  return state
}

function cacheBudgetHooks(wait: LoopHooks["waitForEventWithTimeout"], overrides: Partial<LoopHooks> = {}): LoopHooks {
  return {
    waitForEvent: async () => { throw new Error("seeded warming budget must use a deadline") },
    waitForEventWithTimeout: wait,
    injectIncomingEvent: () => {},
    refreshToolCatalog: () => {},
    flushDeferredEvents: () => {},
    clearSession: async () => {},
    saveSession: async () => {},
    saveShutdownSnapshot: async () => {},
    shouldShutdown: () => false,
    resolveShutdown: () => {},
    ...overrides,
  }
}

test("warming budget overrides idle compaction and ignores an early interrupted wait", async (t) => {
  const state = await makeCacheBudgetState(t)
  const waits: number[] = []
  let refreshes = 0
  await __loopTest.waitForNextEvent(7, state, cacheBudgetHooks(async (timeoutMs) => {
    waits.push(timeoutMs / 60_000)
    t.mock.timers.tick(waits.length === 1 ? 60_000 : timeoutMs)
    return null
  }, { refreshToolCatalog: () => { refreshes++ } }), async () => {
    assert.equal(Date.now(), 324 * 60_000)
    return "rewritten"
  })
  assert.deepEqual(waits, [324, 323])
  assert.equal(refreshes, 1)
})

test("warming-budget compaction retries one refresh interval after a failed rewrite", async (t) => {
  const state = await makeCacheBudgetState(t)
  const waits: number[] = []
  const attempts: number[] = []
  await __loopTest.waitForNextEvent(7, state, cacheBudgetHooks(async (timeoutMs) => {
    waits.push(timeoutMs / 60_000)
    t.mock.timers.tick(timeoutMs)
    return null
  }), async () => {
    attempts.push(Date.now() / 60_000)
    return attempts.length === 1 ? "none" : "rewritten"
  })
  assert.deepEqual(waits, [324, 27])
  assert.deepEqual(attempts, [324, 351])
})

test("an incoming event preempts warming-budget compaction", async (t) => {
  const state = await makeCacheBudgetState(t)
  const event: UserMessage = { source: "chat", triggeredAt: "2026-09-27T00:00:00.000Z", content: "hello", raw: {} }
  let injected: UserMessage | undefined
  await __loopTest.waitForNextEvent(7, state, cacheBudgetHooks(async (timeoutMs) => {
    assert.equal(timeoutMs, 324 * 60_000)
    t.mock.timers.tick(60_000)
    return event
  }, { injectIncomingEvent: (_convId, incoming) => { injected = incoming } }), async () => {
    throw new Error("incoming activity must run before compaction")
  })
  assert.equal(injected, event)
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

test("waitForNextEvent clears a manual compaction request that interrupts the idle wait", async () => {
  const savedIdle = modelState.idleCompactionMs
  modelState.idleCompactionMs = 60_000

  const state = makeState()
  // Below any trigger — idle compaction must still attempt regardless.
  state.contextSize = 0

  let shuttingDown = false
  let timeouts = 0
  await __loopTest.waitForNextEvent(9, state, {
    clientTools: testClientTools,
    refreshToolCatalog: () => {},
    waitForEvent: async () => null,
    // First "timeout" simulates /compact interrupting an already-registered
    // wait. The loop consumes it before subscribing again; the second call
    // proves the request was cleared before exit.
    waitForEventWithTimeout: async () => {
      timeouts += 1
      if (timeouts === 1) {
        state.compactionRequest = { forceSummaryModel: true, snapcompact: true }
      } else {
        assert.equal(state.compactionRequest, undefined)
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
  assert.equal(state.compactionRequest, undefined)
})

test("manual compaction queued during a tool turn runs before the following plain wait", async () => {
  const savedIdle = modelState.idleCompactionMs
  modelState.idleCompactionMs = 0
  const state = makeState()
  const request = { forceSummaryModel: true, snapcompact: false }
  state.compactionRequest = request
  const calls: string[] = []

  try {
    await __loopTest.waitForNextEvent(9, state, {
      clientTools: testClientTools,
      refreshToolCatalog: () => calls.push("refresh"),
      waitForEvent: async () => {
        calls.push("wait")
        throw new Error("queued compaction must run before subscribing to the idle wait")
      },
      waitForEventWithTimeout: async () => { throw new Error("unexpected timeout wait") },
      injectIncomingEvent: () => {},
      flushDeferredEvents: () => {},
      clearSession: async () => {},
      saveSession: async () => {},
      saveShutdownSnapshot: async () => {},
      shouldShutdown: () => false,
      resolveShutdown: () => {},
    }, async (_state, received) => {
      assert.deepEqual(received, request)
      calls.push("compact")
      return "rewritten"
    })
  } finally {
    modelState.idleCompactionMs = savedIdle
  }

  assert.deepEqual(calls, ["compact", "refresh"])
  assert.equal(state.compactionRequest, undefined)
})

test("applyCompaction attempts an idle burn even below the token trigger", async () => {
  const savedStrategy = modelState.compactionStrategy
  const savedTrigger = modelState.compactTriggerTokens
  // companion normally no-ops below trigger; idle must force through anyway.
  modelState.compactionStrategy = "companion"
  modelState.compactTriggerTokens = 100_000

  const state = makeState()
  state.contextSize = 1_000 // well below trigger
  state.context = state.context.fork({ items: [
    makeUserMessage("hello"),
    makeAssistantMessage("hi there"),
  ], reason: "edit" })

  const result = await __loopTest.applyCompaction(state, "idle")
  assert.equal(result, "none")

  modelState.compactionStrategy = savedStrategy
  modelState.compactTriggerTokens = savedTrigger
})

test("voice delegation nudges until voice_reply is called", () => {
  const state = makeState()
  const delegation = makeUserMessage("[incoming — voice]\n\n[voice delegation]\ndelegation_id: d1\ntranscript: find it")
  const unsent = [delegation, makeAssistantMessage("the private result")]
  assert.equal(__loopTest.applyVoiceReplyNudge(state, unsent), true)
  assert.match(String(state.context.items.at(-1)?.content), /did not call voice_reply/)

  const sent = [delegation, makeAssistantMessage("", {
    content: [{ type: "toolCall", id: "call_voice", name: "voice_reply", arguments: { delegation_id: "d1", input_text: "the result" } }],
  })]
  assert.equal(__loopTest.applyVoiceReplyNudge(state, sent), false)
})
