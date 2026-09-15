import { createHash } from "node:crypto"
import type { ToolDefinition } from "@nano/harness-core"
import { buildBootstrap } from "../bootstrap"
import { config } from "../config"
import { areDiscordToolsAvailable } from "../discord/availability"
import { discordEventImageReferences } from "../discord/context-avatars"
import { markDiscordItem } from "../discord/state"
import { clearDiscordTypingScope } from "../discord/typing-lease"
import { endConversation, logMessage, startConversation } from "../db"
import { emit } from "../stream"
import { fromBoredom } from "../triggers/boredom"
import type { Message, UserMessage } from "../types"
import { isWebSearchAvailable } from "../web-search"
import { createBoredomTimer } from "./boredom-timer"
import { archiveContextMessages } from "./context-store"
import { runLoop } from "./loop"
import { createNiriToolCatalog } from "./tool-catalog"
import type { RunnerStateInternal } from "./types"
import {
  archiveDiscardedSession,
  BOREDOM_WAKE_MS,
  clearSession,
  loadRestSnapshot,
  loadSession,
  quarantineSession,
  saveRestSnapshot,
  saveSession,
} from "./util"
import { createRuntimeContext } from "./context"
import { getCompletionTools } from "./tools"

type EnqueueOptions = { onlyIfWaiting?: boolean; priority?: boolean }

const state: RunnerStateInternal = {
  runtimeKind: "frontend",
  contextSize: 0,
  running: false,
  context: createRuntimeContext("frontend"),
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

let eventResolvers: Array<(event: UserMessage | null) => void> = []
let shutdownResolvers: Array<() => void> = []

function catalogFingerprint(catalog: ToolDefinition[]): string {
  return createHash("sha256").update(JSON.stringify(catalog)).digest("hex")
}

function buildCurrentCatalog(): ToolDefinition[] {
  return createNiriToolCatalog({
    clientCapabilities: [],
    workspace: null,
    memory: true,
    discord: areDiscordToolsAvailable(),
    subagents: false,
    computer: false,
    webSearch: isWebSearchAvailable(),
    frontend: true,
    agentChannel: true,
  })
}

function refreshToolCatalog(reason: "new-session" | "post-compaction"): void {
  const catalog = buildCurrentCatalog()
  state.toolCatalog = catalog
  state.toolCatalogFingerprint = catalogFingerprint(catalog)
  state.toolCatalogEpoch += 1
  if (reason === "post-compaction") {
    state.context = state.context.fork({ tools: getCompletionTools(catalog), reason: "tools-change" })
    state.context.append({
      role: "user",
      content: `[tool environment epoch ${state.toolCatalogEpoch}] Frontend server tools refreshed after context rewrite. Executor and skill capabilities remain unavailable.`,
      timestamp: Date.now(),
    } as Message)
  }
}

export function isFrontendRunning(): boolean {
  return state.running
}

export function isFrontendWaitingForEvent(): boolean {
  return eventResolvers.length > 0
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

function deliverEvent(event: UserMessage, options: EnqueueOptions = {}): boolean {
  if (state.shutdownRequested) return false
  if (options.onlyIfWaiting && eventResolvers.length === 0) return false

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

export function enqueueFrontendEvent(event: UserMessage, options: EnqueueOptions = {}): boolean {
  if (!config.frontend.enable) return false
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

export function activateFrontend(event: UserMessage): boolean {
  if (!config.frontend.enable) return false
  if (state.running) enqueueFrontendEvent(event)
  else void wakeFrontend(event)
  return true
}

const boredomTimer = createBoredomTimer(BOREDOM_WAKE_MS, () => {
  if (!config.frontend.enable || state.shutdownRequested || (state.running && !isFrontendWaitingForEvent())) return
  console.log("[frontend] boredom timer fired — activating virtual frontend")
  activateFrontend(state.pendingInputs.shift() ?? fromBoredom())
})

export function startFrontendBoredomTimer(): void {
  if (config.frontend.enable && !state.running && !state.shutdownRequested) boredomTimer.idle()
}

async function saveRuntimeSnapshot(): Promise<void> {
  archiveContextMessages(state.context.items, "runtime-checkpoint", "frontend")
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
  }, "frontend")
  await saveRestSnapshot(state.context.items, "runtime checkpoint", "frontend")
}

export async function shutdownFrontend(): Promise<void> {
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

function waitForEvent(): Promise<UserMessage | null> {
  if (state.shutdownRequested || state.restRequested) return Promise.resolve(null)
  if (state.pendingInputs.length > 0) return Promise.resolve(state.pendingInputs.shift()!)
  const waiting = new Promise<UserMessage | null>((resolve) => eventResolvers.push(resolve))
  boredomTimer.idle()
  return waiting.finally(() => boredomTimer.pause())
}

function waitForEventWithTimeout(timeoutMs: number): Promise<UserMessage | null> {
  if (state.shutdownRequested || state.restRequested) return Promise.resolve(null)
  if (state.pendingInputs.length > 0) return Promise.resolve(state.pendingInputs.shift()!)
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
      markDiscordItem(itemId, "seen", "auto-seen after injection into frontend context", "noted", "frontend")
    } catch (err) {
      console.warn(`[frontend] failed to auto-see Discord item ${itemId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function applyDiscordTargets(event: UserMessage): void {
  if (event.source === "discord") state.discordTargets = event.discordTargets ?? []
  else if (event.source !== "job") state.discordTargets = []
}

function injectIncomingEvent(convId: number, event: UserMessage): void {
  clearDiscordTypingScope(state)
  applyDiscordTargets(event)
  autoSeeDiscordEvent(event)
  const incomingMessage = `[incoming — ${event.source}]\n\n${event.content}`
  state.context.append({
    role: "user",
    content: incomingMessage,
    imageReferences: discordEventImageReferences(event),
    timestamp: Date.now(),
  } as Message)
  logMessage(convId, "user", incomingMessage)
  emit({ type: "user", source: event.source, text: event.content, triggeredAt: event.triggeredAt, clientId: event.clientId })
  state.memoryRecallPending = true
}

export async function wakeFrontend(event: UserMessage): Promise<void> {
  if (!config.frontend.enable) return
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

  const saved = await loadSession("frontend")
  if (saved) {
    state.context = createRuntimeContext("frontend", saved.messages, saved.toolCatalog, {
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
    autoSeeDiscordEvent(event)
    state.context.append({
      role: "user",
      content: `[frontend harness restarted — ${event.source} @ ${event.triggeredAt}]\n\n${event.content}`,
      imageReferences: discordEventImageReferences(event),
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
      discord: areDiscordToolsAvailable(),
      frontend: true,
      agentChannel: true,
    })
    state.toolCatalogEpoch = 0
    refreshToolCatalog("new-session")
    state.context = createRuntimeContext("frontend", bootstrap, state.toolCatalog)
  }

  const convId = startConversation(`frontend:${event.source}`, event.triggeredAt)
  console.log("[frontend] virtual nano-frontend is awake")
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
    try {
      const quarantined = await quarantineSession("frontend")
      console.warn(`[frontend] discarded resumable session after fatal loop abort${quarantined.length ? `; quarantined ${quarantined.join(", ")}` : ""}`)
    } catch (quarantineErr) {
      console.warn(`[frontend] failed to quarantine session after abort: ${quarantineErr instanceof Error ? quarantineErr.message : String(quarantineErr)}`)
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
    console.log("[frontend] virtual nano-frontend is resting")

    if (discarded) state.pendingInputs = []
    if (!wasShutdownRequested && !discarded && state.pendingInputs.length > 0) {
      await wakeFrontend(state.pendingInputs.shift()!)
    } else if (!wasShutdownRequested) {
      startFrontendBoredomTimer()
    }
  }
}
