import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { __loopTest, runLoop } from "./loop"
import { processToolCalls } from "./loop-tools"
import type { Message, UserMessage } from "../types"
import type { LoopHooks, LoopState } from "./types"
import { Context } from "../llm"
import { createExecutionServices } from "../test-model-provider"
import { makeAssistantMessage, makeToolResultMessage, makeUserMessage } from "./test-helpers"
import { createNiriToolCatalog } from "./tool-catalog"

const fixture = await createExecutionServices()
test.after(() => fixture.close())
const { services } = fixture
const modelState = services.model.current()
const fallbackModel = modelState.fallbackModel
const testClientTools = services.client

function makeState(): LoopState {
  return {
    context: new Context({ model: fallbackModel, providerResolver: services.providerResolver, prepareMessages: services.images.prepareMessages }),
    services,
    pendingInputs: [],
    tokenCount: 0,
    contextSize: 0,
    toolCatalog: services.tools.list("main").map(({ definition }) => definition),
    toolCatalogEpoch: 1,
    toolCatalogFingerprint: "",
    toolInFlight: false,
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
  const convId = services.persistence.startConversation("test", new Date().toISOString())
  const state = makeState()
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

test("wait_then_continue injects an interrupted event with one successful tool result", async () => {
  const convId = services.persistence.startConversation("test", new Date().toISOString())
  const state = makeState()
  state.toolCatalog = createNiriToolCatalog({
    contributions: services.tools.list("main"),
    clientCapabilities: services.client.capabilities(),
    workspace: services.client.workspace(),
  })
  const event = {
    source: "chat" as const,
    triggeredAt: "2026-05-01T04:40:00.000Z",
    content: "Please continue with this update.",
    raw: {},
  }
  const injected: unknown[] = []

  const outcome = await processToolCalls(convId, state, {
    clientTools: testClientTools,
    refreshToolCatalog: () => {},
    waitForEvent: async () => null,
    waitForEventWithTimeout: async (timeoutMs) => {
      assert.equal(timeoutMs, 1_000)
      return event
    },
    injectIncomingEvent: (id, incoming) => {
      assert.equal(id, convId)
      injected.push(incoming)
      state.context.append(makeUserMessage(incoming.content))
    },
    flushDeferredEvents: () => {},
    clearSession: async () => {},
    saveSession: async () => {},
    saveShutdownSnapshot: async () => {},
    shouldShutdown: () => false,
    resolveShutdown: () => {},
  }, [{ type: "toolCall", id: "call_wait_then_continue", name: "wait_then_continue", arguments: { timeout_ms: 1_000 } }])

  const results = state.context.items.filter((message) => message.role === "toolResult" && message.toolCallId === "call_wait_then_continue")
  assert.equal(outcome, "continue")
  assert.equal(injected.length, 1)
  assert.equal(injected[0], event)
  assert.equal(results.length, 1)
  const result = results[0]
  assert.ok(result && result.role === "toolResult")
  if (!result || result.role !== "toolResult") throw new Error("expected the wait result")
  assert.equal(result.isError, false)
  assert.match(result.content.map((part) => part.type === "text" ? part.text : "").join(""), /interrupted by an incoming event/i)
  assert.equal(state.context.items.at(-1)?.role, "user")
  assert.match(String(state.context.items.at(-1)?.content), /Please continue with this update/)
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

for (const firstReply of ["wait", "no-tools"] as const) {
  test(`full-context compaction checks for unfinished work before a ${firstReply} reply idles`, async (t) => {
    const convId = services.persistence.startConversation("test", new Date().toISOString())
    const savedModelState = { ...modelState }
    t.after(() => Object.assign(modelState, savedModelState))
    Object.assign(modelState, {
      useFallback: false,
      primaryModel: { ...fallbackModel, id: "post-compact-test", provider: "openai", baseUrl: "https://post-compact.invalid/v1" },
      primaryApiKey: "test",
      primaryToolChoice: "auto",
      primaryNudgeOnNoTool: false,
      cacheWarming: false,
      compactionStrategy: "remote",
      compactTriggerTokens: 100_000,
      idleCompactionMs: 0,
    })

    const state = makeState()
    state.contextSize = 100_000
    state.context = new Context({
      model: modelState.primaryModel!,
      providerResolver: services.providerResolver,
      prepareMessages: services.images.prepareMessages,
      apiKey: "test",
      items: [
        ...Array.from({ length: 50 }, (_, i) => i % 2 === 0
          ? makeUserMessage(`Earlier request ${i}: ${"details ".repeat(35)}`)
          : makeAssistantMessage(`Earlier work ${i}: ${"progress ".repeat(35)}`)),
        makeUserMessage("Finish the current task after compaction."),
      ],
    })
    const prompts: Array<Record<string, any>> = []
    let summaryRequests = 0
    let idleWaits = 0
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, any>
      if (!body.stream) {
        summaryRequests += 1
        return Response.json({
          choices: [{ index: 0, message: { role: "assistant", content: "I was handling the current task and had completed the older steps. The latest request is still open; I should continue it." }, finish_reason: "stop" }],
        })
      }
      prompts.push(body)
      const delta = prompts.length === 1 && firstReply === "wait"
        ? { tool_calls: [{ index: 0, id: "call_wait", type: "function", function: { name: "wait", arguments: "{}" } }] }
        : { content: "Thinking through the remaining work." }
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    })

    const outcome = await runLoop(convId, state, {
      clientTools: testClientTools,
      refreshToolCatalog: () => {},
      waitForEvent: async () => { idleWaits += 1; state.discardRequested = true; return null },
      waitForEventWithTimeout: async () => { idleWaits += 1; state.discardRequested = true; return null },
      injectIncomingEvent: () => {},
      flushDeferredEvents: () => {},
      clearSession: async () => {},
      saveSession: async () => {},
      saveShutdownSnapshot: async () => {},
      shouldShutdown: () => state.discardRequested === true,
      resolveShutdown: () => {},
    })

    assert.equal(outcome, "discard")
    assert.equal(summaryRequests, 1)
    assert.equal(prompts.length, 2)
    assert.equal(idleWaits, 1, "the second idle decision is honored without another retry")
    assert.match(JSON.stringify(prompts[1]!.messages), /Continue any unfinished work from before the compaction/)
  })
}

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
    providerResolver: services.providerResolver,
    prepareMessages: services.images.prepareMessages,
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

test("manual compaction rewrites context with strategy off while preserving prompt-cache preference", async (t) => {
  const savedModelState = { ...modelState }
  t.after(() => Object.assign(modelState, savedModelState))
  Object.assign(modelState, {
    useFallback: false,
    primaryModel: { ...fallbackModel, id: "manual-off-compaction-test", provider: "openai", baseUrl: "https://manual-off.invalid/v1" },
    primaryApiKey: "test",
    summaryModel: null,
    respectPromptCache: true,
    compactionStrategy: "off",
    compactTriggerTokens: 100_000,
    deepArchive: false,
  })

  const state = makeState()
  state.contextSize = 1
  state.context = new Context({
    model: modelState.primaryModel!,
    providerResolver: services.providerResolver,
    prepareMessages: services.images.prepareMessages,
    apiKey: "test",
    items: [
      ...Array.from({ length: 50 }, (_, i) => i % 2 === 0
        ? makeUserMessage(`EXPIRED_HISTORY_MARKER_${i}: ${"older detail ".repeat(40)}`)
        : makeAssistantMessage(`Earlier work ${i}: ${"completed step ".repeat(40)}`)),
      makeUserMessage("The current request must remain available after compaction."),
    ],
  })
  t.mock.method(globalThis, "fetch", async () => Response.json({
    choices: [{ index: 0, message: { role: "assistant", content: "I completed earlier steps and retained the decisions and unresolved work for the next turn." }, finish_reason: "stop" }],
  }))

  const result = await __loopTest.applyManualCompaction(state, { forceSummaryModel: false, snapcompact: false })
  const summary = state.context.items.find((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("[context summary v1]"))
  const allContent = state.context.items.map((message) => typeof message.content === "string" ? message.content : "").join("\n")

  assert.equal(result, "rewritten")
  assert.match(String(summary?.content), /retained the decisions and unresolved work/i)
  assert.match(allContent, /The current request must remain available after compaction/)
  assert.doesNotMatch(allContent, /EXPIRED_HISTORY_MARKER_0:/)
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
