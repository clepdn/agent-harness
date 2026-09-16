import { createHash } from "node:crypto"
import { buildBootstrap } from "../bootstrap"
import { config } from "../config"
import { clientTools } from "../client"
import { areDiscordToolsAvailable } from "../discord/availability"
import { isWebSearchAvailable } from "../web-search"
import { markDiscordItem } from "../discord/state"
import { endConversation, logMessage, startConversation } from "../db"
import { emit } from "../stream"
import { clearDiscordTypingScope } from "../discord/typing-lease"
import { runLoop } from "./loop"
import { setRunnerPresence } from "./presence"
import { createNiriToolCatalog, reconcileImageToolDefinition } from "./tool-catalog"
import { archiveContextMessages } from "./context-store"
import type { ManualCompactionRequest, RunnerStateInternal } from "./types"
import { archiveDiscardedSession, BOREDOM_WAKE_MS, clearSession, loadRestSnapshot, loadSession, quarantineSession, saveRestSnapshot, saveSession } from "./util"
import type { UserMessage, Message } from "../types"
import type { ToolDefinition } from "@nano/harness-core"
import { fromBoredom } from "../triggers/boredom"
import { createBoredomTimer } from "./boredom-timer"
import { discordEventImageReferences } from "../discord/context-avatars"
import { cancelRunningJobs } from "./jobs"
import { createRuntimeContext } from "./context"
import { getCompletionTools } from "./tools"
import { modelStateFor } from "./model-state"

let shutdownResolvers: Array<() => void> = []
const PROCESS_STARTED_AT = new Date().toISOString()
let eventResolvers: Array<(event: UserMessage | null) => void> = []
function catalogFingerprint(catalog: ToolDefinition[]): string {
  return createHash("sha256").update(JSON.stringify(catalog)).digest("hex")
}

function buildCurrentCatalog(): ToolDefinition[] {
  return createNiriToolCatalog({
    clientCapabilities: clientTools.getCapabilities(),
    workspace: clientTools.getWorkspace(),
    memory: true,
    discord: areDiscordToolsAvailable(),
    subagents: config.subagents.length > 0,
    computer: config.computer_use.enabled,
    webSearch: isWebSearchAvailable(),
    vision: modelStateFor("main").primaryVision,
    agentChannel: config.frontend.enable,
  })
}

function refreshToolCatalog(reason: "new-session" | "post-compaction"): void {
  const catalog = buildCurrentCatalog()
  state.toolCatalog = catalog
  state.toolCatalogFingerprint = catalogFingerprint(catalog)
  state.toolCatalogEpoch += 1
  if (reason === "post-compaction") {
    state.context = state.context.fork({ tools: getCompletionTools(catalog, "main"), reason: "tools-change" })
    state.context.append({
      role: "user",
      content: `[tool environment epoch ${state.toolCatalogEpoch}] Tool catalog refreshed after context rewrite. Active workspace and client capabilities are now those captured at this epoch.`,
      timestamp: Date.now(),
    } as Message)
  }
}

function reconcileImageToolCatalog(): void {
  const reconciled = reconcileImageToolDefinition(state.toolCatalog, buildCurrentCatalog())
  if (!reconciled.changed) return
  state.toolCatalog = reconciled.catalog
  state.toolCatalogFingerprint = catalogFingerprint(state.toolCatalog)
  state.toolCatalogEpoch += 1
  state.context = state.context.fork({ tools: getCompletionTools(state.toolCatalog, "main"), reason: "tools-change" })
  state.context.append({
    role: "user",
    content: `[tool environment epoch ${state.toolCatalogEpoch}] image_tool capability refreshed; when available it accepts public HTTP(S) image URLs.`,
    timestamp: Date.now(),
  } as Message)
}

/** Add/remove the bridge when a persisted main session crosses the feature flag. */
function reconcileAgentChannelCatalog(): void {
  const bridgeNames = new Set(["agent_send", "agent_channel"])
  const bridgeCount = state.toolCatalog.filter((tool) => bridgeNames.has(tool.function.name)).length
  if ((config.frontend.enable && bridgeCount === bridgeNames.size) || (!config.frontend.enable && bridgeCount === 0)) return

  if (config.frontend.enable) {
    state.toolCatalog = state.toolCatalog.filter((tool) => !bridgeNames.has(tool.function.name))
    const bridgeTools = buildCurrentCatalog().filter((tool) => bridgeNames.has(tool.function.name))
    const insertAt = state.toolCatalog.findIndex((tool) => tool.function.name === "voice_reply")
    if (insertAt < 0) state.toolCatalog.push(...bridgeTools)
    else state.toolCatalog.splice(insertAt, 0, ...bridgeTools)
  } else {
    state.toolCatalog = state.toolCatalog.filter((tool) => !bridgeNames.has(tool.function.name))
  }
  state.toolCatalogFingerprint = catalogFingerprint(state.toolCatalog)
  state.toolCatalogEpoch += 1
  state.context = state.context.fork({ tools: getCompletionTools(state.toolCatalog, "main"), reason: "tools-change" })
  state.context.append({
    role: "user",
    content: `[tool environment epoch ${state.toolCatalogEpoch}] The durable main/frontend agent channel is now ${config.frontend.enable ? "available" : "unavailable"}.`,
    timestamp: Date.now(),
  } as Message)
}

const state: RunnerStateInternal = {
  runtimeKind: "main",
  contextSize: 0,
  running: false,
  context: createRuntimeContext("main"),
  pendingInputs: [],
  tokenCount: 0,
  toolCatalog: [],
  toolCatalogEpoch: 0,
  toolCatalogFingerprint: "",
  toolInFlight: false,
  memoryRecallCooldowns: {},
  memoryRecallTurn: 0,
  memoryRecallPending: false,
  shutdownRequested: false,
  turnInFlight: false,
  deferredEvents: [],
  restRequested: false,
  restReason: "",
}
/**
 * @returns `true` when the wake loop is running, otherwise `false`.
 */
export function isRunning(): boolean {
  return state.running
}

/** Returns whether the runner is currently blocked in wait or wait_then_continue. */
export function isWaitingForEvent(): boolean {
  return eventResolvers.length > 0
}

/**
 * Requests a programmatic rest at the next turn boundary.
 * The loop will save a rest snapshot with the given reason and exit.
 * If the runner is idle (waiting for events), this also interrupts the wait
 * so the rest takes effect immediately.
 */
export function requestRest(reason: string): boolean {
  if (!state.running) return false
  state.restRequested = true
  state.restReason = reason
  // Interrupt any pending event wait so the loop checks the flag immediately
  interruptEventWaiters()
  return true
}

/**
 * Requests a compaction pass at the next idle wait, regardless of the token
 * trigger. The request may require the configured small summary model and/or a
 * snapcompact frame. If the runner is idle, interrupts the wait so compaction
 * runs immediately. Returns false if not running.
 */
export function requestCompaction(
  options: Partial<ManualCompactionRequest> = {},
): boolean {
  if (!state.running) return false
  state.compactionRequest = {
    forceSummaryModel: options.forceSummaryModel === true,
    snapcompact: options.snapcompact === true,
  }
  interruptEventWaiters()
  return true
}

export type InterruptRequestResult = "interrupted" | "idle" | "not-running"

/** Abort the active model generation or blocking tool without ending its session. */
export function requestInterrupt(): InterruptRequestResult {
  if (!state.running) return "not-running"
  if (!state.turnInFlight && !state.toolInFlight) return "idle"
  state.interruptRequested = true
  state.activeTurnController?.abort(new Error("interrupted by Discord /interrupt"))
  interruptEventWaiters()
  return "interrupted"
}

/** Abort and archive the complete active session, including pending background jobs. */
export function requestDiscard(): boolean {
  if (!state.running) return false
  state.discardRequested = true
  state.activeTurnController?.abort(new Error("session discarded by Discord /discard"))
  cancelRunningJobs("session discarded by Discord /discard")
  interruptEventWaiters()
  return true
}

export function getRunnerStatus(): {
  running: boolean
  idle: boolean
  tokenCount: number
  contextSize: number
  processStartedAt: string
  uptimeMs: number
} {
  return {
    running: state.running,
    idle: isWaitingForEvent(),
    tokenCount: state.tokenCount,
    contextSize: state.contextSize,
    processStartedAt: PROCESS_STARTED_AT,
    uptimeMs: Math.max(0, Date.now() - new Date(PROCESS_STARTED_AT).getTime()),
  }
}

type EnqueueOptions = {
  onlyIfWaiting?: boolean
  priority?: boolean
}

/** Push an event into the live session, resolving the loop's wait if it's idle. */
function deliverEvent(event: UserMessage, options: EnqueueOptions = {}): boolean {
  if (state.shutdownRequested) {
    console.log("[runner] dropping event during shutdown from", event.source)
    return false
  }

  if (options.onlyIfWaiting && eventResolvers.length === 0) {
    return false
  }

  console.log("[runner] queued event from", event.source)
  if (state.toolInFlight) {
    // Defer external steering until the currently running tool settles.
    const deferred = { event, priority: Boolean(options.priority) }
    if (options.priority) {
      state.deferredEvents.unshift(deferred)
    } else {
      state.deferredEvents.push(deferred)
    }
    return true
  }

  // Never push directly into conversation as the loop adds the user message at
  // waitForEvent() time, which is only reached when no tool calls are in flight.
  const resolver = eventResolvers.shift()
  if (resolver) {
    resolver(event)
  } else {
    if (options.priority) {
      state.pendingInputs.unshift(event)
    } else {
      state.pendingInputs.push(event)
    }
  }
  return true
}

function flushDeferredEvents(): void {
  if (state.toolInFlight || state.deferredEvents.length === 0) return
  const events = state.deferredEvents
  state.deferredEvents = []
  for (const { event, priority } of events) {
    deliverEvent(event, { priority })
  }
}

/**
 * Enqueues an event for the active session, or stores it for the next wake cycle.
 * `onlyIfWaiting` rejects the event unless a wait resolver is active.
 *
 * @param event - Trigger event to deliver to the runner.
 * @returns `true` when the event was accepted for delivery.
 */
export function enqueueEvent(event: UserMessage, options: EnqueueOptions = {}): boolean {
  if (state.running) {
    const accepted = deliverEvent(event, options)
    if (accepted) boredomTimer.active()
    return accepted
  }
  if (options.onlyIfWaiting) {
    return false
  }
  if (options.priority) {
    state.pendingInputs.unshift(event)
  } else {
    state.pendingInputs.push(event)
  }
  return true
}

/**
 * Standard activation: enqueue the event if a session is already running,
 * otherwise cold-wake the runner. This is the same pattern the trigger routes
 * use; boredom activations go through it too rather than calling wake() raw.
 */
export function activate(event: UserMessage): void {
  if (isRunning()) enqueueEvent(event)
  else void wake(event)
}

// ── Boredom wake timer ──────────────────────────────────────────────────────
// Arm at startup, after rest, and during event waits. Existing sessions resume
// in place; only resting sessions bootstrap a new loop.
const boredomTimer = createBoredomTimer(BOREDOM_WAKE_MS, () => {
  if (state.shutdownRequested || (state.running && !isWaitingForEvent())) return
  console.log("[runner] boredom timer fired — activating agent")
  // A queued real event takes precedence over a synthetic boredom event.
  activate(state.pendingInputs.shift() ?? fromBoredom())
})

/** Start the initial quiet interval after the worker is ready to serve. */
export function startBoredomTimer(): void {
  if (!state.running && !state.shutdownRequested) boredomTimer.idle()
}

/**
 * Persists the active runner state for a process shutdown.
 *
 * Resolves immediately if no session is currently running.
 *
 * @returns A promise that resolves when shutdown persistence has completed.
 */
export async function shutdown(): Promise<void> {
  boredomTimer.stop()
  if (!state.running || state.context.items.length === 0) return

  state.shutdownRequested = true
  interruptEventWaiters()
  if (state.turnInFlight || state.toolInFlight) {
    await new Promise<void>((resolve) => {
      shutdownResolvers.push(resolve)
    })
    return
  }

  await saveRuntimeSnapshot()
}

function interruptEventWaiters(): void {
  const resolvers = eventResolvers
  eventResolvers = []
  for (const resolve of resolvers) resolve(null)
}

function resolveShutdown(): void {
  const resolvers = shutdownResolvers
  shutdownResolvers = []
  for (const resolve of resolvers) resolve()
}

async function saveRuntimeSnapshot(): Promise<void> {
  archiveContextMessages(state.context.items, "runtime-checkpoint", state.runtimeKind)
  await saveSession({
    version: 1,
    messages: state.context.snapshot(),
    contextId: state.context.id,
    parentContextId: state.context.parentId,
    contextForkReason: state.context.forkReason,
    contextConfigurationFingerprint: state.context.configurationFingerprint,
    contextModelId: state.context.model.id,
    toolCatalog: state.toolCatalog,
    toolCatalogEpoch: state.toolCatalogEpoch,
    toolCatalogFingerprint: state.toolCatalogFingerprint,
    ...(state.discordTargets?.length ? { discordTargets: state.discordTargets } : {}),
  })
  await saveRestSnapshot(state.context.items, "runtime checkpoint")
}

/** Wait until the next event arrives (or return immediately if one is pending). */
function waitForEvent(): Promise<UserMessage | null> {
  if (state.shutdownRequested || state.restRequested) return Promise.resolve(null)
  if (state.pendingInputs.length > 0) return Promise.resolve(state.pendingInputs.shift()!)
  const waiting = new Promise<UserMessage | null>((resolve) => {
    eventResolvers.push(resolve)
  })
  boredomTimer.idle()
  return waiting.finally(() => boredomTimer.pause())
}

/** Wait up to timeoutMs for the next event; resolves null if the timer fires first. */
function waitForEventWithTimeout(timeoutMs: number): Promise<UserMessage | null> {
  if (state.shutdownRequested || state.restRequested) return Promise.resolve(null)
  if (state.pendingInputs.length > 0) {
    return Promise.resolve(state.pendingInputs.shift()!)
  }
  const waiting = new Promise<UserMessage | null>((resolve) => {
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const idx = eventResolvers.indexOf(resolver)
      if (idx !== -1) eventResolvers.splice(idx, 1)
      resolve(null)
    }, timeoutMs)

    const resolver = (event: UserMessage | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(event)
    }

    eventResolvers.push(resolver)
  })
  boredomTimer.idle()
  return waiting.finally(() => boredomTimer.pause())
}

function formatIncomingEvent(event: UserMessage): string {
  return `[incoming — ${event.source}]\n\n${event.content}`
}

function applyDiscordTargets(event: UserMessage): void {
  if (event.source === "discord") state.discordTargets = event.discordTargets ?? []
  else if (event.source !== "job") state.discordTargets = []
}

function autoSeeDiscordEvent(event: UserMessage): void {
  if (event.source !== "discord") return

  const itemIds = [
    ...(event.discordTargets ?? []).map((target) => target.itemId ?? target.messageId),
    ...[...event.content.matchAll(/^source_item_id:\s*(\S+)/gm)].map((match) => match[1]),
  ]
    .map((itemId) => itemId?.trim())
    .filter((itemId): itemId is string => Boolean(itemId))
  for (const itemId of new Set(itemIds)) {
    try {
      markDiscordItem(itemId, "seen", "auto-seen after injection into runner context", "noted")
    } catch (err) {
      console.warn(`[runner] failed to auto-see Discord item ${itemId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function emitUserEvent(event: UserMessage): void {
  emit({
    type: "user",
    source: event.source,
    text: event.content,
    triggeredAt: event.triggeredAt,
    clientId: event.clientId,
  })
}

function injectIncomingEvent(convId: number, event: UserMessage): void {
  clearDiscordTypingScope(state)
  applyDiscordTargets(event)
  autoSeeDiscordEvent(event)
  const incomingMessage = formatIncomingEvent(event)
  state.context.append({
    role: "user",
    content: incomingMessage,
    imageReferences: discordEventImageReferences(event),
    timestamp: Date.now(),
  } as Message)
  logMessage(convId, "user", incomingMessage)
  emitUserEvent(event)
  // A new incoming event starts a new turn — recall once for it.
  state.memoryRecallPending = true
  console.log("[runner] injected event from", event.source)
}

/**
 * Starts the runner loop for an incoming trigger event.
 *
 * If a session is already active, the event is queued instead of starting a new loop.
 *
 * @param event - Event that should wake or steer the runner.
 * @returns A promise that resolves once this wake cycle fully completes.
 */
export async function wake(event: UserMessage): Promise<void> {
  // Any wake cancels a pending boredom timer — a real (or synthetic) activation
  // is now in flight, so we don't want the idle timer firing on top of it.
  boredomTimer.active()

  if (state.running) {
    enqueueEvent(event)
    return
  }

  state.running = true
  setRunnerPresence("awake")
  state.tokenCount = 0
  state.contextSize = 0
  state.memoryRecallCooldowns = {}
  state.memoryRecallTurn = 0
  // The wake event is the first turn — recall once for it.
  state.memoryRecallPending = true
  state.restRequested = false
  state.restReason = ""
  state.interruptRequested = false
  state.discardRequested = false

  const saved = await loadSession()
  if (saved) {
    state.context = createRuntimeContext("main", saved.messages, saved.toolCatalog, {
      id: saved.contextId,
      parentId: saved.parentContextId,
      forkReason: saved.contextForkReason,
      configurationFingerprint: saved.contextConfigurationFingerprint,
      modelId: saved.contextModelId,
    })
    state.toolCatalog = saved.toolCatalog
    state.toolCatalogEpoch = saved.toolCatalogEpoch
    state.toolCatalogFingerprint = saved.toolCatalogFingerprint
    state.discordTargets = saved.discordTargets ?? []
    applyDiscordTargets(event)
    reconcileAgentChannelCatalog()
    reconcileImageToolCatalog()
    autoSeeDiscordEvent(event)
    state.context.append({
      role: "user",
      content: `[harness restarted — ${event.source} @ ${event.triggeredAt}]\n\n${event.content}`,
      imageReferences: discordEventImageReferences(event),
      timestamp: Date.now(),
    } as Message)
  } else {
    state.discordTargets = []
    applyDiscordTargets(event)
    autoSeeDiscordEvent(event)
    const restSnapshot = await loadRestSnapshot()
    const priorRest = restSnapshot ? { restedAt: restSnapshot.restedAt, note: restSnapshot.note, forest: restSnapshot.summary } : null
    const bootstrap = await buildBootstrap(event, priorRest, {
      clientCapabilities: clientTools.getCapabilities(),
      workspace: clientTools.getWorkspace(),
      discord: areDiscordToolsAvailable(),
      vision: modelStateFor("main").primaryVision,
      agentChannel: config.frontend.enable,
    })
    state.toolCatalogEpoch = 0
    refreshToolCatalog("new-session")
    state.context = createRuntimeContext("main", bootstrap, state.toolCatalog)
  }
  const convId = startConversation(event.source, event.triggeredAt)
  console.log("[runner] nano is awake")

  let discarded = false
  try {
    const exit = await runLoop(convId, state, {
      clientTools,
      onTurnStart: () => boredomTimer.active(),
      refreshToolCatalog: () => refreshToolCatalog("post-compaction"),
      waitForEvent,
      waitForEventWithTimeout,
      injectIncomingEvent,
      flushDeferredEvents,
      clearSession,
      saveSession: saveRuntimeSnapshot,
      saveShutdownSnapshot: saveRuntimeSnapshot,
      shouldShutdown: () => state.shutdownRequested,
      resolveShutdown,
    })
    if (exit === "discard") {
      discarded = true
      const archive = await archiveDiscardedSession({
        version: 1,
        messages: state.context.snapshot(),
        contextId: state.context.id,
        parentContextId: state.context.parentId,
        contextForkReason: state.context.forkReason,
        contextConfigurationFingerprint: state.context.configurationFingerprint,
        contextModelId: state.context.model.id,
        toolCatalog: state.toolCatalog,
        toolCatalogEpoch: state.toolCatalogEpoch,
        toolCatalogFingerprint: state.toolCatalogFingerprint,
      })
      console.log(`[runner] discarded session archived at ${archive}`)
    }
    setRunnerPresence("resting")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[runner] loop aborted: ${message}`)
    if (err instanceof Error && err.stack) console.error(err.stack)
    try {
      const quarantined = await quarantineSession()
      console.warn(`[runner] discarded resumable session after fatal loop abort${quarantined.length ? `; quarantined ${quarantined.join(", ")}` : ""}`)
    } catch (quarantineErr) {
      console.warn(`[runner] failed to quarantine session after abort: ${quarantineErr instanceof Error ? quarantineErr.message : String(quarantineErr)}`)
    }
  } finally {
    const wasShutdownRequested = state.shutdownRequested
    endConversation(convId, state.tokenCount)
    state.running = false
    state.context = state.context.fork({ items: [], reason: "reset" })
    state.toolInFlight = false
    state.memoryRecallCooldowns = {}
    state.memoryRecallTurn = 0
    state.memoryRecallPending = false
    state.shutdownRequested = false
    state.turnInFlight = false
    state.activeTurnController = undefined
    state.operationSignal = undefined
    state.interruptRequested = false
    state.discardRequested = false
    state.restRequested = false
    state.restReason = ""
    state.compactionRequest = undefined
    state.discordTargets = []
    if (!wasShutdownRequested && !discarded) flushDeferredEvents()
    state.deferredEvents = []
    eventResolvers = []
    resolveShutdown()
    setRunnerPresence("resting")
    console.log("[runner] nano is resting")

    if (discarded) state.pendingInputs = []
    if (!wasShutdownRequested && !discarded && state.pendingInputs.length > 0) {
      const next = state.pendingInputs.shift()!
      console.log("[runner] pending event queued, waking again")
      await wake(next)
    } else if (!wasShutdownRequested) {
      // Genuinely idle now — arm the boredom timer so the agent comes back on
      // its own after a quiet stretch instead of resting forever.
      startBoredomTimer()
    }
  }
}
