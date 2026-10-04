import { createHash, randomUUID } from "node:crypto"
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
import { createNiriToolCatalog, reconcileImageToolDefinition, reconcileMemoryFileToolDefinitions } from "./tool-catalog"
import { archiveContextMessages, recordRestContextSnapshot } from "./context-store"
import type { ManualCompactionRequest, RunnerStateInternal } from "./types"
import { archiveDiscardedSession, BOREDOM_WAKE_MS, clearSession, loadRestSnapshot, loadSession, quarantineSession, saveRestSnapshot, saveSession } from "./util"
import type { UserMessage, Message } from "../types"
import type { ToolDefinition } from "@nano/harness-core"
import { fromBoredom } from "../triggers/boredom"
import { createBoredomTimer } from "./boredom-timer"
import { discordEventImageReferences } from "../discord/context-avatars"
import { registerDiscordTargets, rewriteDiscordTargetLabels } from "../discord/targets"
import { cancelRunningJobs, hasExecutingJobs } from "./jobs"
import { createRuntimeContext } from "./context"
import { getCompletionTools } from "./tools"
import { applyModelSwap, persistModelSwap, resolveModelSwap, modelStateFor, type ModelSwapSelection } from "./model-state"
import { clearModelSwapHandoff, loadModelSwapHandoff, saveModelSwapHandoff } from "./session"
import { beginFrontendModelSwap, resumeFrontendAfterModelSwap, frontendModelSwapSnapshot, setFrontendModelSwapCheckpoint, checkpointFrontendModelSwapReplay } from "./frontend"

let shutdownResolvers: Array<() => void> = []
export type ModelSwapResult = {
  preset: string
  model: string
  provider: string
  graceful: boolean
  fallbackReason?: string
}

export type ModelSwapTestOptions = Partial<SwapOptions>
export interface SwapOptions {
  boundaryWaitMs: number
  toolSettleMs: number
  gracefulDeadlineMs: number
  gracefulTurnLimit: number
}
const MODEL_SWAP_DEFAULTS: SwapOptions = {
  boundaryWaitMs: 15_000,
  toolSettleMs: 5_000,
  gracefulDeadlineMs: 90_000,
  gracefulTurnLimit: 8,
}

type PendingModelSwap = {
  selection: ModelSwapSelection
  id: string
  eventIds: Map<UserMessage, string>
  deliveredIds: string[]
  deliveredEvents: UserMessage[]
  options: SwapOptions
  phase: "closing" | "selected"
  messages: Message[]
  close: (result: { graceful: boolean; fallbackReason?: string }) => void
  fail: (error: Error) => void
  timers: Set<NodeJS.Timeout>
  checkpoint: Promise<void>
  checkpointError?: unknown
  bootstrapReady?: () => void
  releaseBootstrap?: () => void
  bootstrapFailed?: (error: unknown) => void
  wakeEvent?: UserMessage
}
let pendingModelSwap: PendingModelSwap | undefined
let heldSwapEvents: UserMessage[] = []
let recoveryChecked = false

function swapPrompt(preset: string): UserMessage {
  return {
    source: "system", triggeredAt: new Date().toISOString(), raw: null,
    content: `[model swap handoff] The operator is switching to preset "${preset}". Journal durable lessons and pending work now using memory_fs and edit_file. Then call end_session with a concise handoff note. Do not continue ordinary work or call unrelated mutating tools.`,
  }
}

function checkpointModelSwap(): Promise<void> {
  const swap = pendingModelSwap
  if (!swap) return Promise.resolve()
  const frontend = frontendModelSwapSnapshot()
  const events = [...swap.deliveredEvents, ...heldSwapEvents]
  const snapshot = {
    version: 1 as const, id: swap.id, preset: swap.selection.preset, phase: swap.phase,
    eventIds: events.map(event => swap.eventIds.get(event)!),
    messages: swap.phase === "closing" && state.running ? state.context.snapshot() : swap.messages,
    events, note: "operator-requested model swap",
    ...(frontend ? { frontendMessages: frontend.messages, frontendEvents: frontend.events, frontendId: frontend.id, frontendEventIds: frontend.eventIds } : {}),
  }
  swap.checkpoint = swap.checkpoint.then(() => saveModelSwapHandoff(snapshot))
  swap.checkpoint.catch(error => { swap.checkpointError = error })
  return swap.checkpoint
}

function holdSwapEvent(event: UserMessage, options: { priority?: boolean } = {}): boolean {
  if (!pendingModelSwap) return false
  pendingModelSwap.eventIds.set(event, randomUUID())
  if (options.priority) heldSwapEvents.unshift(event)
  else heldSwapEvents.push(event)
  void checkpointModelSwap()
  return true
}

function armSwapTimer(swap: PendingModelSwap, delay: number, action: () => void): void {
  const timer = setTimeout(() => {
    swap.timers.delete(timer)
    if (pendingModelSwap === swap) action()
  }, delay)
  swap.timers.add(timer)
}

function failBlockedSwap(swap: PendingModelSwap, reason: string): void {
  swap.fail(new Error(`model swap failed safely: ${reason}; selected settings were not applied`))
}

function startGracefulDeadline(swap: PendingModelSwap): void {
  for (const timer of swap.timers) clearTimeout(timer)
  swap.timers.clear()
  state.modelSwap!.deadlineAt = Date.now() + swap.options.gracefulDeadlineMs
  armSwapTimer(swap, swap.options.gracefulDeadlineMs, () => {
    if (state.toolInFlight || state.compactionInFlight) {
      failBlockedSwap(swap, "journal/end deadline reached while a tool or compaction is still executing")
      return
    }
    state.modelSwap!.fallbackRequested = true
    state.modelSwap!.fallbackReason = "journal/end handoff exceeded its deadline"
    state.restRequested = true
    state.restReason = state.modelSwap!.fallbackReason
    state.activeTurnController?.abort(new Error(state.restReason))
    interruptEventWaiters()
    armSwapTimer(swap, swap.options.toolSettleMs, () => {
      if (state.running) failBlockedSwap(swap, "cancelled generation did not settle")
    })
  })
}

/** Close outgoing sessions before installing a preset and scheduling a fresh session. */
export async function requestModelSwap(presetName: string): Promise<ModelSwapResult> {
  return requestModelSwapInternal(presetName)
}

async function requestModelSwapInternal(presetName: string, overrides?: ModelSwapTestOptions): Promise<ModelSwapResult> {
  if (pendingModelSwap) throw new Error("model swap already in progress")
  if (hasExecutingJobs()) throw new Error("model swap failed safely: background tasks are still executing; wait for them to finish")
  const selection = resolveModelSwap(presetName)
  const options = { ...MODEL_SWAP_DEFAULTS, ...overrides }
  let close!: PendingModelSwap["close"]
  let fail!: PendingModelSwap["fail"]
  const closed = new Promise<{ graceful: boolean; fallbackReason?: string }>((resolve, reject) => { close = resolve; fail = reject })
  const swap: PendingModelSwap = {
    selection, id: randomUUID(), eventIds: new Map(), deliveredIds: [], deliveredEvents: [], options, phase: "closing", messages: state.context.snapshot(), close, fail,
    timers: new Set(), checkpoint: Promise.resolve(),
  }
  pendingModelSwap = swap
  heldSwapEvents = state.pendingInputs.splice(0)
  heldSwapEvents.push(...state.deferredEvents.splice(0).map(item => item.event))
  for (const event of heldSwapEvents) swap.eventIds.set(event, randomUUID())
  boredomTimer.pause()
  state.modelSwap = {
    preset: selection.preset, prompt: swapPrompt(selection.preset).content,
    turns: 0, turnLimit: options.gracefulTurnLimit, deadlineAt: Number.POSITIVE_INFINITY,
    promptId: randomUUID(), onStarted: () => startGracefulDeadline(swap),
    onCheckpoint: () => { void checkpointModelSwap() },
  }
  const frontendClosing = config.frontend.enable && config.frontend.preset === undefined
    ? beginFrontendModelSwap(selection.preset, options)
    : Promise.resolve({ graceful: true } as { graceful: boolean; fallbackReason?: string })
  frontendClosing.catch(error => fail(error instanceof Error ? error : new Error(String(error))))
  setFrontendModelSwapCheckpoint(() => { void checkpointModelSwap() })
  try {
    await checkpointModelSwap()
    if (state.running) interruptEventWaiters()
    else {
      swap.wakeEvent = swapPrompt(selection.preset)
      void wake(swap.wakeEvent).catch(error => fail(error instanceof Error ? error : new Error(String(error))))
    }
    armSwapTimer(swap, options.boundaryWaitMs, () => {
      if (state.modelSwap?.started || !state.running) return
      if (state.toolInFlight || state.compactionInFlight || !state.activeTurnController) {
        failBlockedSwap(swap, "outgoing tool or compaction did not reach a safe boundary")
        return
      }
      state.activeTurnController.abort(new Error("model swap boundary deadline"))
      armSwapTimer(swap, options.toolSettleMs, () => {
        if (!state.modelSwap?.started && state.running) failBlockedSwap(swap, "outgoing generation did not settle")
      })
    })
    const [mainResult, frontendResult] = await Promise.all([closed, frontendClosing])
    if (swap.checkpointError) throw swap.checkpointError
    await checkpointModelSwap()
    if (hasExecutingJobs()) throw new Error("background task has not stopped; selected settings were not applied")
    await persistModelSwap(selection)
    applyModelSwap(selection)
    swap.phase = "selected"
    await checkpointModelSwap()
    const ready = new Promise<void>((resolve, reject) => { swap.bootstrapReady = resolve; swap.bootstrapFailed = reject })
    swap.wakeEvent = { source: "system", raw: null, triggeredAt: new Date().toISOString(), content: `[model swap complete] Fresh session using preset "${selection.preset}". Resume preserved pending work from the handoff.` }
    void wake(swap.wakeEvent).catch(error => swap.bootstrapFailed?.(error))
    await ready
    await resumeFrontendAfterModelSwap()
    await swap.checkpoint
    while (true) {
      while (heldSwapEvents.length) {
        for (const event of heldSwapEvents.splice(0)) {
          injectIncomingEvent(activeSwapConversation!, event)
          swap.deliveredIds.push(swap.eventIds.get(event)!)
          swap.deliveredEvents.push(event)
        }
        await saveRuntimeSnapshot()
      }
      await checkpointFrontendModelSwapReplay()
      await swap.checkpoint
      await clearModelSwapHandoff()
      const frontend = frontendModelSwapSnapshot()
      if (!heldSwapEvents.length && (!frontend || frontend.eventIds.every(id => frontend.deliveredEventIds.includes(id)))) break
      await checkpointModelSwap()
    }
    pendingModelSwap = undefined
    recoveryChecked = true
    setFrontendModelSwapCheckpoint(undefined)
    swap.releaseBootstrap?.()
    const fallbackReason = [mainResult.fallbackReason, frontendResult.fallbackReason].filter(Boolean).join("; ")
    return { preset: selection.preset, model: selection.model.id, provider: selection.model.provider,
      graceful: mainResult.graceful && frontendResult.graceful, ...(fallbackReason ? { fallbackReason } : {}) }
  } catch (error) {
    const selected = swap.phase === "selected"
    state.modelSwap = undefined
    pendingModelSwap = undefined
    setFrontendModelSwapCheckpoint(undefined)
    state.pendingInputs.push(...heldSwapEvents.splice(0))
    swap.releaseBootstrap?.()
    await swap.checkpoint.catch(() => {})
    if (!selected && !swap.checkpointError) await clearModelSwapHandoff().catch(() => {})
    await resumeFrontendAfterModelSwap().catch(() => {})
    throw new Error(`model swap failed safely: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  } finally {
    for (const timer of swap.timers) clearTimeout(timer)
  }
}

let activeSwapConversation: number | undefined
/** Recover a crashed handoff before any external event can restore its old context. */
export async function recoverModelSwapHandoff(): Promise<void> {
  if (recoveryChecked) return
  const handoff = await loadModelSwapHandoff()
  if (!handoff) {
    recoveryChecked = true
    return
  }
  const selection = resolveModelSwap(handoff.preset)
  const archiveLane = async (messages: Message[], kind: "main" | "frontend") => {
    const saved = await loadSession(kind)
    const retained = [...messages, ...(saved?.messages ?? [])]
    const archived = recordRestContextSnapshot(retained, "model swap recovered after worker restart", kind)
    await saveRestSnapshot(retained, "model swap recovered after worker restart", kind, archived.forest)
    await clearSession(kind)
  }
  if (handoff.phase !== "selected") {
    await archiveLane(handoff.messages, "main")
    if (handoff.frontendMessages) await archiveLane(handoff.frontendMessages, "frontend")
    await persistModelSwap(selection)
    applyModelSwap(selection)
  }
  const saveQueued = async (kind: "main" | "frontend", events: UserMessage[], eventIds?: string[], handoffId = handoff.id) => {
    const existing = await loadSession(kind)
    const messages = existing?.messages ?? []
    const replayed = new Set(existing?.modelSwapHandoffId === handoffId ? existing?.modelSwapEventIds ?? [] : [])
    for (let index = 0; index < events.length; index++) {
      const event = events[index]!
      const id = eventIds?.[index]
      if (id && replayed.has(id)) continue
      messages.push({ role: "user", content: formatIncomingEvent(event), timestamp: Date.now(), imageReferences: discordEventImageReferences(event) })
      if (id) replayed.add(id)
    }
    if (!existing) {
      const rest = await loadRestSnapshot(kind)
      const event: UserMessage = { source: "system", raw: null, triggeredAt: new Date().toISOString(), content: "[model swap recovered] Start fresh and resume the preserved pending work." }
      const catalog = kind === "main" ? buildCurrentCatalog() : createNiriToolCatalog({ frontend: true, memory: true, discord: areDiscordToolsAvailable(), agentChannel: true, vision: modelStateFor("frontend").primaryVision })
      const bootstrap = await buildBootstrap(event, rest ? { restedAt: rest.restedAt, note: rest.note, forest: rest.summary } : null, { frontend: kind === "frontend", vision: modelStateFor(kind).primaryVision, agentChannel: config.frontend.enable })
      const context = createRuntimeContext(kind, [...bootstrap, ...messages], catalog)
      await saveSession({ version: 1, messages: context.snapshot(), contextId: context.id, contextModelId: context.model.id, contextConfigurationFingerprint: context.configurationFingerprint, toolCatalog: catalog, toolCatalogEpoch: 1, toolCatalogFingerprint: catalogFingerprint(catalog), modelSwapHandoffId: handoffId, modelSwapEventIds: [...replayed] }, kind)
    } else {
      await saveSession({ ...existing, messages, modelSwapHandoffId: handoffId, modelSwapEventIds: [...replayed] }, kind)
    }
  }
  await saveQueued("main", handoff.events, handoff.eventIds)
  if (handoff.frontendMessages || handoff.frontendEvents?.length) await saveQueued("frontend", handoff.frontendEvents ?? [], handoff.frontendEventIds, handoff.frontendId)
  await clearModelSwapHandoff()
  recoveryChecked = true
  console.warn("[model-swap] recovered interrupted handoff using archived history; model-driven journaling was not verified")
}
export const __test = { requestModelSwap: requestModelSwapInternal }
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

function reconcileFileToolCatalog(): void {
  const current = buildCurrentCatalog()
  const image = reconcileImageToolDefinition(state.toolCatalog, current)
  const memoryFiles = reconcileMemoryFileToolDefinitions(image.catalog, current)
  if (!image.changed && !memoryFiles.changed) return
  state.toolCatalog = memoryFiles.catalog
  state.toolCatalogFingerprint = catalogFingerprint(state.toolCatalog)
  state.toolCatalogEpoch += 1
  state.context = state.context.fork({ tools: getCompletionTools(state.toolCatalog, "main"), reason: "tools-change" })
  state.context.append({
    role: "user",
    content: `[tool environment epoch ${state.toolCatalogEpoch}] ${[
      image.changed ? "image_tool capability refreshed; when available it accepts public HTTP(S) image URLs." : null,
      memoryFiles.changed ? "memory:// read_file exposes LINE#HASH anchors, and edit_file accepts anchored hashline edits." : null,
    ].filter(Boolean).join(" ")}`,
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
  if (holdSwapEvent(event, options)) return true
  if (state.shutdownRequested) {
    console.log("[runner] dropping event during shutdown from", event.source)
    return false
  }
  if (options.onlyIfWaiting && eventResolvers.length === 0) return false
  console.log("[runner] queued event from", event.source)
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
  if (holdSwapEvent(event, options)) return true
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
  if (holdSwapEvent(event)) return
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
    contextEffortState: state.context.effortState,
    toolCatalog: state.toolCatalog,
    toolCatalogEpoch: state.toolCatalogEpoch,
    toolCatalogFingerprint: state.toolCatalogFingerprint,
    ...(state.discordTargets?.length ? { discordTargets: state.discordTargets } : {}),
    ...(pendingModelSwap?.phase === "selected" ? { modelSwapHandoffId: pendingModelSwap.id, modelSwapEventIds: [...pendingModelSwap.deliveredIds] } : {}),
  })
  await saveRestSnapshot(state.context.items, "runtime checkpoint")
}

function holdResolvedSwapEvent(event: UserMessage | null): UserMessage | null {
  return event && holdSwapEvent(event) ? null : event
}

/** Wait until the next event arrives (or return immediately if one is pending). */
function waitForEvent(): Promise<UserMessage | null> {
  if (state.shutdownRequested || state.restRequested) return Promise.resolve(null)
  if (state.pendingInputs.length > 0) return Promise.resolve(state.pendingInputs.shift()!).then(holdResolvedSwapEvent)
  const waiting = new Promise<UserMessage | null>((resolve) => {
    eventResolvers.push(resolve)
  })
  boredomTimer.idle()
  return waiting.finally(() => boredomTimer.pause()).then(holdResolvedSwapEvent)
}

/** Wait up to timeoutMs for the next event; resolves null if the timer fires first. */
function waitForEventWithTimeout(timeoutMs: number): Promise<UserMessage | null> {
  if (state.shutdownRequested || state.restRequested) return Promise.resolve(null)
  if (state.pendingInputs.length > 0) {
    return Promise.resolve(state.pendingInputs.shift()!).then(holdResolvedSwapEvent)
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
  return waiting.finally(() => boredomTimer.pause()).then(holdResolvedSwapEvent)
}

function formatIncomingEvent(event: UserMessage): string {
  return `[incoming — ${event.source}]\n\n${event.content}`
}

function applyDiscordTargets(event: UserMessage): void {
  if (event.source !== "discord") return
  const incoming = event.discordTargets ?? []
  const registered = registerDiscordTargets(state.discordTargets ?? [], incoming)
  event.content = rewriteDiscordTargetLabels(event.content, incoming, registered.incomingTargets)
  event.discordTargets = registered.incomingTargets
  state.discordTargets = registered.targets
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
  if (pendingModelSwap && event !== pendingModelSwap.wakeEvent) {
    holdSwapEvent(event)
    return
  }
  if (!pendingModelSwap) await recoverModelSwapHandoff()
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
  let convId: number
  try {

  const saved = await loadSession()
  if (saved) {
    state.context = createRuntimeContext("main", saved.messages, saved.toolCatalog, {
      id: saved.contextId,
      parentId: saved.parentContextId,
      forkReason: saved.contextForkReason,
      configurationFingerprint: saved.contextConfigurationFingerprint,
      modelId: saved.contextModelId,
      effortState: saved.contextEffortState,
    })
    state.toolCatalog = saved.toolCatalog
    state.toolCatalogEpoch = saved.toolCatalogEpoch
    state.toolCatalogFingerprint = saved.toolCatalogFingerprint
    state.discordTargets = saved.discordTargets ?? []
    applyDiscordTargets(event)
    reconcileAgentChannelCatalog()
    reconcileFileToolCatalog()
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
  convId = startConversation(event.source, event.triggeredAt)
  console.log("[runner] nano is awake")

  if (pendingModelSwap?.phase === "selected") {
    activeSwapConversation = convId
    for (const queued of heldSwapEvents.splice(0)) {
      injectIncomingEvent(convId, queued)
      pendingModelSwap.deliveredIds.push(pendingModelSwap.eventIds.get(queued)!)
      pendingModelSwap.deliveredEvents.push(queued)
    }
    await saveRuntimeSnapshot()
    await new Promise<void>(resolve => {
      pendingModelSwap!.releaseBootstrap = resolve
      pendingModelSwap!.bootstrapReady?.()
    })
  }
  } catch (error) {
    state.running = false
    state.modelSwap = undefined
    state.toolInFlight = false
    state.turnInFlight = false
    state.activeTurnController = undefined
    state.operationSignal = undefined
    resolveShutdown()
    pendingModelSwap?.bootstrapFailed?.(error)
    pendingModelSwap?.fail(error instanceof Error ? error : new Error(String(error)))
    throw error
  }
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
        contextEffortState: state.context.effortState,
        toolCatalog: state.toolCatalog,
        toolCatalogEpoch: state.toolCatalogEpoch,
        toolCatalogFingerprint: state.toolCatalogFingerprint,
      })
      console.log(`[runner] discarded session archived at ${archive}`)
    }
    setRunnerPresence("resting")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (pendingModelSwap?.phase === "closing") {
      state.modelSwap!.fallbackReason = `outgoing session failed: ${message}`
    } else {
    console.error(`[runner] loop aborted: ${message}`)
    if (err instanceof Error && err.stack) console.error(err.stack)
    try {
      const quarantined = await quarantineSession()
      console.warn(`[runner] discarded resumable session after fatal loop abort${quarantined.length ? `; quarantined ${quarantined.join(", ")}` : ""}`)
    } catch (quarantineErr) {
      console.warn(`[runner] failed to quarantine session after abort: ${quarantineErr instanceof Error ? quarantineErr.message : String(quarantineErr)}`)
    }
    }
  } finally {
    const wasShutdownRequested = state.shutdownRequested
    const closingSwap = pendingModelSwap?.phase === "closing" ? pendingModelSwap : undefined
    if (closingSwap) {
      try {
        closingSwap.messages = state.context.snapshot()
        const graceful = state.modelSwap?.completed === true && state.modelSwap.journaled === true
        const fallbackReason = graceful ? undefined : state.modelSwap?.fallbackReason ?? "outgoing model did not complete end_session"
        const archived = recordRestContextSnapshot(closingSwap.messages, fallbackReason ?? "model swap", "main")
        await saveRestSnapshot(closingSwap.messages, fallbackReason ?? "model swap", "main", archived.forest)
        await checkpointModelSwap()
        await clearSession("main")
        closingSwap.close({ graceful, ...(fallbackReason ? { fallbackReason } : {}) })
      } catch (error) {
        closingSwap.fail(error instanceof Error ? error : new Error(String(error)))
      }
    }
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
    state.discordTargets = []
    if (!pendingModelSwap && !wasShutdownRequested && !discarded) flushDeferredEvents()
    if (!pendingModelSwap) state.deferredEvents = []
    eventResolvers = []
    resolveShutdown()
    setRunnerPresence("resting")
    console.log("[runner] nano is resting")
    if (closingSwap) return

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
