import { createHash, randomUUID } from "node:crypto"
import type { ToolDefinition } from "@nano/harness-core"
import { config } from "@nano/runtime-api/config"
import { BOREDOM_WAKE_MS } from "../settings"
import { fromBoredom } from "../triggers/boredom"
import type { RuntimeExecutionServices } from "@nano/runtime-api"
import { registerDiscordTargets, rewriteDiscordTargetLabels } from "@nano/plugin-discord/targets"
import type { Message, UserMessage } from "@nano/runtime-api/types"
import { createBoredomTimer } from "./boredom-timer"
import { runLoop } from "./loop"
import { createNiriToolCatalog, reconcileImageToolDefinition, reconcileMemoryFileToolDefinitions } from "@nano/plugin-tools"
import type { RunnerStateInternal } from "./types"
import type { InterruptRequestResult } from "@nano/runtime-api/contracts/runner"
import { createRuntimeContext } from "./context"
import { getCompletionTools } from "@nano/plugin-tools"

export type FrontendModelSwapOptions = {
  boundaryWaitMs: number
  toolSettleMs: number
  gracefulDeadlineMs: number
  gracefulTurnLimit: number
}

export type FrontendModelSwapSnapshot = { messages: Message[]; events: UserMessage[]; id: string; eventIds: string[]; deliveredEventIds: string[] }
type EnqueueOptions = { onlyIfWaiting?: boolean; priority?: boolean }
type FrontendModelSwap = {
  preset: string
  id: string
  eventIds: Map<UserMessage, string>
  delivered: UserMessage[]
  deliveredIds: string[]
  replayConversation?: number
  options: FrontendModelSwapOptions
  phase: "closing" | "closed" | "failed" | "resuming"
  activeAtStart: boolean
  wasWaitingAtStart: boolean
  events: UserMessage[]
  messages: Message[]
  timers: Set<NodeJS.Timeout>
  resolveClose: (result: { graceful: boolean; fallbackReason?: string }) => void
  rejectClose: (error: Error) => void
  resolveResume?: () => void
  rejectResume?: (error: Error) => void
  release?: Promise<void>
  resolveRelease?: () => void
  checkpointDetached?: boolean
  onCheckpoint?: () => void
  failure?: Error
}
export interface FrontendRunnerRuntime {
  isFrontendRunning(): boolean
  isFrontendWaitingForEvent(): boolean
  getFrontendRunnerStatus(): { running: boolean; idle: boolean; tokenCount: number; contextSize: number }
  enqueueFrontendEvent(event: UserMessage, options?: EnqueueOptions): boolean
  activateFrontend(event: UserMessage, options?: { priority?: boolean }): boolean
  startFrontendBoredomTimer(): void
  wakeFrontend(event: UserMessage): Promise<void>
  requestInterrupt(): InterruptRequestResult
  shutdownFrontend(): Promise<void>
  cleanup(): Promise<void>
  beginFrontendModelSwap(preset: string, options: FrontendModelSwapOptions): Promise<{ graceful: boolean; fallbackReason?: string }>
  resumeFrontendAfterModelSwap(): Promise<void>
  frontendModelSwapSnapshot(): FrontendModelSwapSnapshot | undefined
  setFrontendModelSwapCheckpoint(checkpoint?: () => void): void
  checkpointFrontendModelSwapReplay(): Promise<void>
}

export function createFrontendRunnerRuntime(services: RuntimeExecutionServices): FrontendRunnerRuntime {
  const frontendServices = services
  let frontendModelSwap: FrontendModelSwap | undefined
  let frontendModelSwapCheckpoint: (() => void) | undefined
  let state!: RunnerStateInternal
  let eventResolvers: Array<(event: UserMessage | null) => void> = []
  let shutdownResolvers: Array<() => void> = []
  let stoppedResolvers: Array<() => void> = []
  let frontendColdWakePromise: Promise<void> | undefined
  async function prepareFrontendMessages(messages: Message[]): Promise<void> {
    const prepare = frontendServices.images?.prepareMessages
    if (!prepare) throw new Error("nano.frontend requires nano.images prepareMessages")
    await prepare(messages)
  }
  function requiredPersistence() {
    const value = frontendServices.persistence
    if (!value) throw new Error("nano.frontend requires nano.persistence")
    return value
  }
  function loadSession(kind: "frontend" = "frontend") { return requiredPersistence().loadSession(kind) }
  function saveSession(snapshot: Parameters<NonNullable<RuntimeExecutionServices["persistence"]>["saveSession"]>[0], kind: "frontend" = "frontend") { return requiredPersistence().saveSession(snapshot, kind) }
  function clearSession(kind: "frontend" = "frontend") { return requiredPersistence().clearSession(kind) }
  function loadRestSnapshot(kind: "frontend" = "frontend") { return requiredPersistence().loadRestSnapshot(kind) }
  function saveRestSnapshot(...args: Parameters<NonNullable<RuntimeExecutionServices["persistence"]>["saveRestSnapshot"]>) { return requiredPersistence().saveRestSnapshot(...args) }
  function archiveDiscardedSession(...args: Parameters<NonNullable<RuntimeExecutionServices["persistence"]>["archiveDiscardedSession"]>) { return requiredPersistence().archiveDiscardedSession(...args) }
  function quarantineSession(...args: Parameters<NonNullable<RuntimeExecutionServices["persistence"]>["quarantineSession"]>) { return requiredPersistence().quarantineSession(...args) }
  function startConversation(...args: Parameters<NonNullable<RuntimeExecutionServices["persistence"]>["startConversation"]>) { return requiredPersistence().startConversation(...args) }
  function logMessage(...args: Parameters<NonNullable<RuntimeExecutionServices["persistence"]>["logMessage"]>) { return requiredPersistence().logMessage(...args) }
  function endConversation(...args: Parameters<NonNullable<RuntimeExecutionServices["persistence"]>["endConversation"]>) { return requiredPersistence().endConversation(...args) }
  function recordRestContextSnapshot(...args: Parameters<NonNullable<RuntimeExecutionServices["persistence"]>["recordRestContextSnapshot"]>) { return requiredPersistence().recordRestContextSnapshot(...args) }
  function buildBootstrap(event: UserMessage, priorRest: Parameters<NonNullable<RuntimeExecutionServices["bootstrap"]>["build"]>[1] = null, options: Parameters<NonNullable<RuntimeExecutionServices["bootstrap"]>["build"]>[2] = {}) {
    const bootstrap = frontendServices.bootstrap
    if (!bootstrap) throw new Error("nano.frontend requires nano.bootstrap")
    return bootstrap.build(event, priorRest, options)
  }
  function emit(event: Parameters<NonNullable<RuntimeExecutionServices["events"]>["emit"]>[0]): void { frontendServices.events?.emit(event) }
  function frontendModelConfig(kind: "frontend" | "main" = "frontend") {
    const model = frontendServices.model
    if (!model) throw new Error("nano.frontend requires nano.model")
    return model.current(kind)
  }
  function catalogFingerprint(catalog: ToolDefinition[]): string { return createHash("sha256").update(JSON.stringify(catalog)).digest("hex") }
  function resolveStopped(): void {
    const resolvers = stoppedResolvers
    stoppedResolvers = []
    for (const resolve of resolvers) resolve()
  }
  state = {
    runtimeKind: "frontend", contextSize: 0, running: false, services: frontendServices,
    context: createRuntimeContext("frontend", [], undefined, undefined, services.providerResolver, prepareFrontendMessages, services.model),
    pendingInputs: [], tokenCount: 0, toolCatalog: [], toolCatalogEpoch: 0, toolCatalogFingerprint: "",
    toolInFlight: false, memoryRecallCooldowns: {}, memoryRecallTurn: 0, memoryRecallPending: false,
    shutdownRequested: false, turnInFlight: false, deferredEvents: [], restRequested: false, restReason: "",
  }

  const boredomTimer = createBoredomTimer(BOREDOM_WAKE_MS, () => {
    if (!config.frontend.enable || state.shutdownRequested || (state.running && !isFrontendWaitingForEvent())) return
    console.log("[frontend] boredom timer fired — activating virtual frontend")
    activateFrontend(state.pendingInputs.shift() ?? fromBoredom())
  })
  function buildCurrentCatalog(): ToolDefinition[] {
    const services = frontendServices
    return createNiriToolCatalog({
      contributions: services.tools?.list("frontend") ?? [],
      clientCapabilities: [],
      workspace: null,
      computer: false,
      vision: frontendModelConfig("frontend").primaryVision,
      frontend: true,
    })
  }
  function refreshToolCatalog(reason: "new-session" | "post-compaction"): void {
  const catalog = buildCurrentCatalog()
  state.toolCatalog = catalog
  state.toolCatalogFingerprint = catalogFingerprint(catalog)
  state.toolCatalogEpoch += 1
  if (reason === "post-compaction") {
    state.context = state.context.fork({ tools: getCompletionTools(catalog, "frontend"), reason: "tools-change" })
    state.context.append({
      role: "user",
      content: `[tool environment epoch ${state.toolCatalogEpoch}] Frontend server tools refreshed after context rewrite. Executor and skill capabilities remain unavailable.`,
      timestamp: Date.now(),
    } as Message)
  }
}

  function reconcileFileToolCatalog(): void {
  const current = buildCurrentCatalog()
  const image = reconcileImageToolDefinition(state.toolCatalog, current)
  const memoryFiles = reconcileMemoryFileToolDefinitions(image.catalog, current)
  if (!image.changed && !memoryFiles.changed) return
  state.toolCatalog = memoryFiles.catalog
  state.toolCatalogFingerprint = catalogFingerprint(state.toolCatalog)
  state.toolCatalogEpoch += 1
  state.context = state.context.fork({ tools: getCompletionTools(state.toolCatalog, "frontend"), reason: "tools-change" })
  state.context.append({
    role: "user",
    content: `[tool environment epoch ${state.toolCatalogEpoch}] ${[
      image.changed ? "image_tool capability refreshed; it accepts public HTTP(S) image URLs." : null,
      memoryFiles.changed ? "memory:// read_file exposes LINE#HASH anchors, and edit_file accepts anchored hashline edits." : null,
    ].filter(Boolean).join(" ")}`,
    timestamp: Date.now(),
  } as Message)
}

  function isFrontendRunning(): boolean {
  return state.running
}

  function isFrontendWaitingForEvent(): boolean {
  return eventResolvers.length > 0
}

  function getFrontendRunnerStatus(): {
  running: boolean
  idle: boolean
  tokenCount: number
  contextSize: number
} {
  return {
    running: state.running,
    idle: isFrontendWaitingForEvent(),
    tokenCount: state.tokenCount,
    contextSize: state.contextSize,
  }
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
  function notifyFrontendSwapCheckpoint(): void {
  const swap = frontendModelSwap
  if (!swap) return
  if (swap.phase === "closing" && state.running) swap.messages = state.context.snapshot()
  ;(swap.onCheckpoint ?? frontendModelSwapCheckpoint)?.()
}

  function holdFrontendSwapEvent(event: UserMessage, options: EnqueueOptions = {}): void {
  const swap = frontendModelSwap
  if (!swap) return
  swap.eventIds.set(event, randomUUID())
  if (options.priority) swap.events.unshift(event)
  else swap.events.push(event)
  notifyFrontendSwapCheckpoint()
}
  function deliverEvent(event: UserMessage, options: EnqueueOptions = {}): boolean {
  if (state.shutdownRequested) return false
  if (options.onlyIfWaiting && eventResolvers.length === 0) return false
  if (frontendModelSwap) {
    holdFrontendSwapEvent(event, options)
    return true
  }

  console.log("[frontend] queued event from", event.source)
  if (state.toolInFlight) {
    const deferred = { event, priority: Boolean(options.priority) }
    if (options.priority) state.deferredEvents.unshift(deferred)
    else state.deferredEvents.push(deferred)
    return true
  }

  const resolver = eventResolvers.shift()
  if (resolver) resolver(event)
  else if (options.priority) state.pendingInputs.unshift(event)
  else state.pendingInputs.push(event)
  return true
}

  function flushDeferredEvents(): void {
  if (state.toolInFlight || state.deferredEvents.length === 0) return
  const events = state.deferredEvents
  state.deferredEvents = []
  for (const { event, priority } of events) deliverEvent(event, { priority })
}

  function enqueueFrontendEvent(event: UserMessage, options: EnqueueOptions = {}): boolean {
  if (!config.frontend.enable) return false
  if (frontendModelSwap) {
    if (options.onlyIfWaiting && eventResolvers.length === 0) return false
    holdFrontendSwapEvent(event, options)
    return true
  }
  if (state.running) {
    const accepted = deliverEvent(event, options)
    if (accepted) boredomTimer.active()
    return accepted
  }
  if (options.onlyIfWaiting) return false
  if (options.priority) state.pendingInputs.unshift(event)
  else state.pendingInputs.push(event)
  return true
}

  function activateFrontend(event: UserMessage, options: { priority?: boolean } = {}): boolean {
  if (!config.frontend.enable) return false
  if (state.running || frontendModelSwap || frontendColdWakePromise) return enqueueFrontendEvent(event, options)
  frontendColdWakePromise ??= wakeFrontend(event)
    .catch((error) => { console.error("[frontend] activation failed:", error) })
    .finally(() => { frontendColdWakePromise = undefined })
  return true
}

  function startFrontendBoredomTimer(): void {
  if (config.frontend.enable && !state.running && !state.shutdownRequested) boredomTimer.idle()
}
  async function saveRuntimeSnapshot(): Promise<void> {
  await saveSession({
    version: 1,
    messages: state.context.snapshot(),
    contextId: state.context.id,
    parentContextId: state.context.parentId,
    contextForkReason: state.context.forkReason,
    contextConfigurationFingerprint: state.context.configurationFingerprint,
    contextModelId: state.context.model.id,
    contextEffortState: state.context.effortState,
    toolCatalog: state.toolCatalog,
    toolCatalogEpoch: state.toolCatalogEpoch,
    toolCatalogFingerprint: state.toolCatalogFingerprint,
    ...(state.discordTargets?.length ? { discordTargets: state.discordTargets } : {}),
    ...(frontendModelSwap?.phase === "resuming" ? { modelSwapHandoffId: frontendModelSwap.id, modelSwapEventIds: [...frontendModelSwap.deliveredIds] } : {}),
  }, "frontend")
  await saveRestSnapshot(state.context.items, "runtime checkpoint", "frontend")
}
  function armFrontendSwapTimer(swap: FrontendModelSwap, delayMs: number, callback: () => void): void {
  const timer = setTimeout(() => {
    swap.timers.delete(timer)
    if (frontendModelSwap === swap && swap.phase === "closing") callback()
  }, Math.max(1, delayMs))
  swap.timers.add(timer)
}

  function failFrontendSwap(swap: FrontendModelSwap, reason: string): void {
  if (frontendModelSwap !== swap || swap.phase !== "closing") return
  const error = new Error(`frontend model swap failed safely: ${reason}; selected settings were not applied`)
  for (const timer of swap.timers) clearTimeout(timer)
  swap.timers.clear()
  swap.failure = error
  swap.phase = "failed"
  const held = swap.events.splice(0)
  state.pendingInputs.unshift(...held)
  state.modelSwap = undefined
  frontendModelSwap = undefined
  if (state.running && eventResolvers.length) interruptEventWaiters()
  swap.rejectClose(error)
}

  function startFrontendGracefulDeadline(swap: FrontendModelSwap): void {
  for (const timer of swap.timers) clearTimeout(timer)
  swap.timers.clear()
  if (state.modelSwap) state.modelSwap.deadlineAt = Date.now() + swap.options.gracefulDeadlineMs
  armFrontendSwapTimer(swap, swap.options.gracefulDeadlineMs, () => {
    if (state.toolInFlight || state.compactionInFlight) {
      failFrontendSwap(swap, "journal/end deadline reached while a tool or compaction is still executing")
      return
    }
    if (state.modelSwap) {
      state.modelSwap.fallbackRequested = true
      state.modelSwap.fallbackReason = "journal/end handoff exceeded its deadline"
    }
    state.restRequested = true
    state.restReason = "model swap handoff deadline exceeded"
    state.interruptRequested = true
    state.activeTurnController?.abort(new Error(state.restReason))
    interruptEventWaiters()
    armFrontendSwapTimer(swap, swap.options.toolSettleMs, () => {
      if (state.running) failFrontendSwap(swap, "cancelled generation did not settle")
    })
  })
}

  function beginFrontendClose(swap: FrontendModelSwap): void {
  if (!state.running) return
  state.modelSwap = {
    preset: swap.preset,
    prompt: `[model swap handoff] The operator is switching to preset "${swap.preset}". Journal durable lessons and pending work now using memory_fs and edit_file where appropriate. Then call end_session with a concise handoff note. Do not continue ordinary work or call unrelated mutating tools.`,
    turns: 0,
    turnLimit: swap.options.gracefulTurnLimit,
    deadlineAt: Number.POSITIVE_INFINITY,
    promptId: randomUUID(),
    onStarted: () => startFrontendGracefulDeadline(swap),
    onCheckpoint: () => notifyFrontendSwapCheckpoint(),
  }
  interruptEventWaiters()
  armFrontendSwapTimer(swap, swap.options.boundaryWaitMs, () => {
    if (state.modelSwap?.started || !state.running) return
    if (state.toolInFlight || state.compactionInFlight || !state.turnInFlight || !state.activeTurnController) {
      failFrontendSwap(swap, "outgoing tool or compaction did not reach a safe boundary")
      return
    }
    state.interruptRequested = true
    state.activeTurnController.abort(new Error("frontend model swap boundary deadline"))
    armFrontendSwapTimer(swap, swap.options.toolSettleMs, () => {
      if (!state.modelSwap?.started && state.running) failFrontendSwap(swap, "outgoing generation did not settle")
    })
  })
}

/** Persist events arriving while the selected lane waits for the parent commit. */
  async function checkpointFrontendModelSwapReplay(): Promise<void> {
  const swap = frontendModelSwap
  if (!swap || swap.phase !== "resuming" || swap.replayConversation === undefined) return
  while (swap.events.length) {
    for (const event of swap.events.splice(0)) {
      swap.delivered.push(event)
      swap.deliveredIds.push(swap.eventIds.get(event)!)
      injectIncomingEvent(swap.replayConversation, event)
    }
    await saveRuntimeSnapshot()
  }
}

/** Current outgoing frontend history and events held outside its model context. */
  function frontendModelSwapSnapshot(): FrontendModelSwapSnapshot | undefined {
  const swap = frontendModelSwap
  if (!swap) return undefined
  const events = [...swap.delivered, ...swap.events]
  return { messages: swap.messages.slice(), events, id: swap.id, eventIds: events.map(event => swap.eventIds.get(event)!), deliveredEventIds: [...swap.deliveredIds] }
}

/** Attach the parent handoff checkpoint writer while frontend state is gated. */
  function setFrontendModelSwapCheckpoint(checkpoint?: () => void): void {
  frontendModelSwapCheckpoint = checkpoint
  const swap = frontendModelSwap
  if (!swap) return
  swap.onCheckpoint = checkpoint
  if (checkpoint) {
    checkpoint()
    return
  }
  if (swap.phase !== "resuming" && swap.phase !== "failed") return
  frontendModelSwap = undefined
  const held = swap.events.splice(0)
  for (const event of held) deliverEvent(event)
  if (state.running && held.length) interruptEventWaiters()
  swap.checkpointDetached = true
  swap.resolveRelease?.()
}

/** Close an inherited frontend context before the parent installs a new preset. */
  async function beginFrontendModelSwap(
  preset: string,
  options: FrontendModelSwapOptions,
): Promise<{ graceful: boolean; fallbackReason?: string }> {
  if (frontendModelSwap) throw new Error("frontend model swap already in progress")
  const wasRunning = state.running
  const wasWaitingAtStart = wasRunning && isFrontendWaitingForEvent()
  let resolveClose!: (result: { graceful: boolean; fallbackReason?: string }) => void
  let rejectClose!: (error: Error) => void
  const closed = new Promise<{ graceful: boolean; fallbackReason?: string }>((resolve, reject) => {
    resolveClose = resolve
    rejectClose = reject
  })
  const held = state.deferredEvents.splice(0)
  const priorityEvents = held.filter(item => item.priority).map(item => item.event)
  const ordinaryDeferredEvents = held.filter(item => !item.priority).map(item => item.event)
  const pending = state.pendingInputs.splice(0)
  const swap: FrontendModelSwap = {
    preset,
    id: randomUUID(), eventIds: new Map(), delivered: [], deliveredIds: [],
    options,
    phase: "closing",
    activeAtStart: wasRunning || pending.length > 0 || held.length > 0 || Boolean(state.context.items.length),
    wasWaitingAtStart,
    events: [...priorityEvents, ...pending, ...ordinaryDeferredEvents],
    messages: wasRunning ? state.context.snapshot() : [],
    timers: new Set(),
    resolveClose,
    rejectClose,
  }
  for (const event of swap.events) swap.eventIds.set(event, randomUUID())
  frontendModelSwap = swap
  boredomTimer.pause()
  notifyFrontendSwapCheckpoint()

  if (wasRunning) {
    beginFrontendClose(swap)
  } else {
    void (async () => {
      try {
        const saved = await loadSession("frontend")
        if (frontendModelSwap !== swap || swap.phase !== "closing") return
        if (saved) {
          swap.messages = saved.messages.slice()
          swap.activeAtStart = true
        }
        if (swap.messages.length) {
          const archived = recordRestContextSnapshot(swap.messages, "frontend model swap while resting", "frontend")
          await saveRestSnapshot(swap.messages, "frontend model swap while resting", "frontend", archived.forest)
        }
        await clearSession("frontend")
        if (frontendModelSwap !== swap || swap.phase !== "closing") return
        swap.phase = "closed"
        notifyFrontendSwapCheckpoint()
        swap.resolveClose(swap.messages.length ? { graceful: false, fallbackReason: "frontend was already resting" } : { graceful: true })
      } catch (error) {
        failFrontendSwap(swap, `could not archive resting session: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }
  return closed
}

/** Resume the frontend using the globally selected preset and held events. */
  async function resumeFrontendAfterModelSwap(): Promise<void> {
  const swap = frontendModelSwap
  if (!swap || swap.phase === "failed") return
  if (swap.phase !== "closed") throw new Error("frontend model swap has not closed")
  if (!config.frontend.enable) {
    swap.phase = "resuming"
    setFrontendModelSwapCheckpoint(undefined)
    return
  }
  swap.phase = "resuming"
  state.modelSwap = undefined
  let resolveResume!: () => void
  let rejectResume!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveResume = resolve; rejectResume = reject })
  let resolveRelease!: () => void
  const release = new Promise<void>(resolve => { resolveRelease = resolve })
  swap.resolveResume = resolveResume
  swap.rejectResume = rejectResume
  swap.release = release
  swap.resolveRelease = resolveRelease
  if (!frontendModelSwapCheckpoint) {
    swap.checkpointDetached = true
    resolveRelease()
  }
  const event: UserMessage = {
    source: "system",
    raw: null,
    triggeredAt: new Date().toISOString(),
    content: `[model swap complete] Fresh frontend session using preset "${swap.preset}". Resume preserved pending work from the handoff.`,
  }
  void wakeFrontend(event).catch(error => {
    state.running = false
    state.modelSwap = undefined
    resolveStopped()
    const failure = error instanceof Error ? error : new Error(String(error))
    swap.failure = failure
    swap.phase = "failed"
    swap.rejectResume?.(failure)
  })
  await ready
  if (!frontendModelSwapCheckpoint) setFrontendModelSwapCheckpoint(undefined)
}

  async function shutdownFrontend(): Promise<void> {
  boredomTimer.stop()
  if (!state.running || state.context.items.length === 0) return
  state.shutdownRequested = true
  interruptEventWaiters()
  if (state.turnInFlight || state.toolInFlight) {
    await new Promise<void>((resolve) => shutdownResolvers.push(resolve))
    return
  }
  await saveRuntimeSnapshot()
}

  function holdResolvedSwapEvent(event: UserMessage | null): UserMessage | null {
  if (!event || !frontendModelSwap || frontendModelSwap.phase === "resuming") return event
  holdFrontendSwapEvent(event)
  return null
}

  function waitForEvent(): Promise<UserMessage | null> {
  if (state.shutdownRequested || state.restRequested) return Promise.resolve(null)
  if (state.pendingInputs.length > 0) return Promise.resolve(holdResolvedSwapEvent(state.pendingInputs.shift()!))
  const waiting = new Promise<UserMessage | null>((resolve) => eventResolvers.push(resolve))
  boredomTimer.idle()
  return waiting.finally(() => boredomTimer.pause()).then(holdResolvedSwapEvent)
}

  function waitForEventWithTimeout(timeoutMs: number): Promise<UserMessage | null> {
  if (state.shutdownRequested || state.restRequested) return Promise.resolve(null)
  if (state.pendingInputs.length > 0) return Promise.resolve(holdResolvedSwapEvent(state.pendingInputs.shift()!))
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
  return waiting.finally(() => boredomTimer.pause()).then(holdResolvedSwapEvent)
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
    try { frontendServices.discord?.markDiscordItem(itemId, "seen", "auto-seen after injection into frontend context", "noted", "frontend") }
    catch (err) { console.warn(`[frontend] failed to auto-see Discord item ${itemId}: ${err instanceof Error ? err.message : String(err)}`) }
  }
}

  function applyDiscordTargets(event: UserMessage): void {
  if (event.source !== "discord") return
  const incoming = event.discordTargets ?? []
  const registered = registerDiscordTargets(state.discordTargets ?? [], incoming)
  event.content = rewriteDiscordTargetLabels(event.content, incoming, registered.incomingTargets)
  event.discordTargets = registered.incomingTargets
  state.discordTargets = registered.targets
}

  function injectIncomingEvent(convId: number, event: UserMessage): void {
  frontendServices.discord?.stopTyping(state.discordTypingTurnId)
  state.discordTypingTurnId = undefined
  state.discordTypingChannelId = undefined
  applyDiscordTargets(event)
  autoSeeDiscordEvent(event)
  const incomingMessage = `[incoming — ${event.source}]\n\n${event.content}`
  state.context.append({ role: "user", content: incomingMessage, imageReferences: frontendServices.discord?.discordEventImageReferences(event) ?? [], timestamp: Date.now() } as Message)
  logMessage(convId, "user", incomingMessage)
  emit({ type: "user", source: event.source, text: event.content, triggeredAt: event.triggeredAt, clientId: event.clientId })
  state.memoryRecallPending = true
}
  async function wakeFrontend(event: UserMessage): Promise<void> {
  if (!config.frontend.enable) return
  if (frontendModelSwap && frontendModelSwap.phase !== "resuming") {
    holdFrontendSwapEvent(event)
    return
  }
  boredomTimer.active()
  if (state.running) {
    enqueueFrontendEvent(event)
    return
  }

  state.running = true
  state.tokenCount = 0
  state.contextSize = 0
  state.memoryRecallCooldowns = {}
  state.memoryRecallTurn = 0
  state.memoryRecallPending = true
  state.restRequested = false
  state.restReason = ""
  state.interruptRequested = false
  state.discardRequested = false

  let convId: number
  try {
  const saved = await loadSession("frontend")
  if (saved) {
    state.context = createRuntimeContext("frontend", saved.messages, saved.toolCatalog, {
      id: saved.contextId,
      parentId: saved.parentContextId,
      forkReason: saved.contextForkReason,
      configurationFingerprint: saved.contextConfigurationFingerprint,
      modelId: saved.contextModelId,
      effortState: saved.contextEffortState,
    }, frontendServices.providerResolver, prepareFrontendMessages, frontendServices.model)
    state.toolCatalog = saved.toolCatalog
    state.toolCatalogEpoch = saved.toolCatalogEpoch
    state.toolCatalogFingerprint = saved.toolCatalogFingerprint
    state.discordTargets = saved.discordTargets ?? []
    reconcileFileToolCatalog()
    applyDiscordTargets(event)
    autoSeeDiscordEvent(event)
    state.context.append({
      role: "user",
      content: `[frontend harness restarted — ${event.source} @ ${event.triggeredAt}]\n\n${event.content}`,
      imageReferences: frontendServices.discord?.discordEventImageReferences(event) ?? [],
      timestamp: Date.now(),
    } as Message)
  } else {
    state.discordTargets = []
    applyDiscordTargets(event)
    autoSeeDiscordEvent(event)
    const restSnapshot = await loadRestSnapshot("frontend")
    const priorRest = restSnapshot
      ? { restedAt: restSnapshot.restedAt, note: restSnapshot.note, forest: restSnapshot.summary }
      : null
    const bootstrap = await buildBootstrap(event, priorRest, {
      clientCapabilities: [],
      workspace: null,
      discord: Boolean(frontendServices.discord?.available),
      frontend: true,
      vision: frontendModelConfig("frontend").primaryVision,
      agentChannel: true,
    })
    state.toolCatalogEpoch = 0
    refreshToolCatalog("new-session")
    state.context = createRuntimeContext("frontend", bootstrap, state.toolCatalog, undefined, frontendServices.providerResolver, prepareFrontendMessages, frontendServices.model)
  }
  convId = startConversation(`frontend:${event.source}`, event.triggeredAt)
  const swap = frontendModelSwap?.phase === "resuming" ? frontendModelSwap : undefined
  if (swap) {
    swap.replayConversation = convId
    for (const queued of swap.events.splice(0)) {
      swap.delivered.push(queued)
      swap.deliveredIds.push(swap.eventIds.get(queued)!)
      injectIncomingEvent(convId, queued)
    }
    await saveRuntimeSnapshot()
    swap.resolveResume?.()
    await swap.release
  }
  console.log("[frontend] virtual nano-frontend is awake")
  } catch (error) {
    state.running = false
    state.modelSwap = undefined
    state.toolInFlight = false
    state.turnInFlight = false
    state.activeTurnController = undefined
    state.operationSignal = undefined
    resolveShutdown()
    resolveStopped()
    throw error
  }
  let discarded = false
  try {
    const exit = await runLoop(convId, state, {
      onTurnStart: () => boredomTimer.active(),
      refreshToolCatalog: () => refreshToolCatalog("post-compaction"),
      waitForEvent,
      waitForEventWithTimeout,
      injectIncomingEvent,
      flushDeferredEvents,
      clearSession: () => clearSession("frontend"),
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
        contextEffortState: state.context.effortState,
        toolCatalog: state.toolCatalog,
        toolCatalogEpoch: state.toolCatalogEpoch,
        toolCatalogFingerprint: state.toolCatalogFingerprint,
      }, "frontend")
      console.log(`[frontend] discarded session archived at ${archive}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[frontend] loop aborted: ${message}`)
    if (err instanceof Error && err.stack) console.error(err.stack)
    if (!frontendModelSwap) {
      try {
        const quarantined = await quarantineSession("frontend")
        console.warn(`[frontend] discarded resumable session after fatal loop abort${quarantined.length ? `; quarantined ${quarantined.join(", ")}` : ""}`)
      } catch (quarantineErr) {
        console.warn(`[frontend] failed to quarantine session after abort: ${quarantineErr instanceof Error ? quarantineErr.message : String(quarantineErr)}`)
      }
    }
  } finally {
    const wasShutdownRequested = state.shutdownRequested
    const closingSwap = frontendModelSwap?.phase === "closing" ? frontendModelSwap : undefined
    let swapResult: { graceful: boolean; fallbackReason?: string } | undefined
    let swapError: Error | undefined
    if (closingSwap) {
      try {
        closingSwap.messages = state.context.snapshot()
        const graceful = state.modelSwap?.completed === true && state.modelSwap.journaled === true
        const fallbackReason = graceful ? undefined : state.modelSwap?.fallbackReason ?? "outgoing frontend did not complete end_session"
        if (!graceful && closingSwap.messages.length) {
          const archived = recordRestContextSnapshot(closingSwap.messages, fallbackReason ?? "model swap", "frontend")
          await saveRestSnapshot(closingSwap.messages, fallbackReason ?? "model swap", "frontend", archived.forest)
        }
        await clearSession("frontend")
        swapResult = { graceful, ...(fallbackReason ? { fallbackReason } : {}) }
        closingSwap.phase = "closed"
        notifyFrontendSwapCheckpoint()
      } catch (error) {
        swapError = error instanceof Error ? error : new Error(String(error))
        closingSwap.failure = swapError
        closingSwap.phase = "failed"
      }
    }
    for (const timer of closingSwap?.timers ?? []) clearTimeout(timer)
    closingSwap?.timers.clear()
    endConversation(convId, state.tokenCount)
    state.running = false
    state.modelSwap = undefined
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
    state.compactionInFlight = false
    state.discordTargets = []
    if (!closingSwap && !wasShutdownRequested && !discarded) flushDeferredEvents()
    if (!closingSwap) state.deferredEvents = []
    eventResolvers = []
    resolveShutdown()
    resolveStopped()
    console.log("[frontend] virtual nano-frontend is resting")

    if (closingSwap) {
      if (swapError) closingSwap.rejectClose(swapError)
      else closingSwap.resolveClose(swapResult ?? { graceful: false, fallbackReason: "frontend closed without a handoff result" })
      return
    }

    if (discarded) state.pendingInputs = []
    if (!wasShutdownRequested && !discarded && state.pendingInputs.length > 0) {
      await wakeFrontend(state.pendingInputs.shift()!)
    } else if (!wasShutdownRequested) {
      startFrontendBoredomTimer()
    }
  }
  }

  function requestInterrupt(): InterruptRequestResult {
    if (!state.running) return "not-running"
    if (!state.turnInFlight && !state.toolInFlight) {
      interruptEventWaiters()
      return "idle"
    }
    state.interruptRequested = true
    state.activeTurnController?.abort(new Error("interrupted by Discord /interrupt"))
    interruptEventWaiters()
    return "interrupted"
  }

  async function cleanup(): Promise<void> {
    boredomTimer.stop()
    state.pendingInputs = []
    state.deferredEvents = []
    if (!state.running) {
      for (const timer of frontendModelSwap?.timers ?? []) clearTimeout(timer)
      frontendModelSwap?.timers.clear()
      return
    }
    state.shutdownRequested = true
    state.restRequested = true
    state.restReason = "frontend runtime cleanup"
    state.interruptRequested = true
    state.activeTurnController?.abort(new Error(state.restReason))
    interruptEventWaiters()
    await new Promise<void>(resolve => stoppedResolvers.push(resolve))
    for (const timer of frontendModelSwap?.timers ?? []) clearTimeout(timer)
    frontendModelSwap?.timers.clear()
  }

  return {
    isFrontendRunning,
    isFrontendWaitingForEvent,
    getFrontendRunnerStatus,
    enqueueFrontendEvent,
    activateFrontend,
    startFrontendBoredomTimer,
    wakeFrontend,
    requestInterrupt,
    shutdownFrontend,
    cleanup,
    beginFrontendModelSwap,
    resumeFrontendAfterModelSwap,
    frontendModelSwapSnapshot,
    setFrontendModelSwapCheckpoint,
    checkpointFrontendModelSwapReplay,
  }
}
