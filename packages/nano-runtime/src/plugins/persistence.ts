import type Database from "better-sqlite3"
import path from "node:path"
import type { Plugin } from "@nano/plugins"
import { createWorkerOutbox, type WorkerOutbox } from "../awp/outbox"
import { createDatabase, startConversationIn, logMessageIn, endConversationIn } from "../db"
import { createStateHistory, type StateHistoryService } from "../state-history"
import { NANO_HOME } from "../agent-config"
import { nano, type ConversationHistoryInput, type ConversationHistoryItem, type PersistenceService } from "./api"
import { createContextStore, type ContextStoreService } from "../runner/context-store"
import { createSessionStore } from "../runner/session"
export interface PersistencePluginConfig {
  readonly path?: string
  readonly home?: string
  readonly replayTailRows?: number
}


export function createPersistenceService(options: PersistencePluginConfig = {}): PersistenceService {
  const home = path.resolve(options.home ?? NANO_HOME)
  const sessions = createSessionStore(home)
  let database: Database.Database | undefined
  let vectorAvailable = false
  let outbox: WorkerOutbox | undefined
  let stateHistory: StateHistoryService | undefined
  let contextStore: ContextStoreService | undefined
  let initializing: Promise<void> | undefined
  let initializingPath: string | undefined
  let initializedPath: string | undefined
  let closing: Promise<void> | undefined
  let closed = false

  const resolveDatabasePath = (override?: string): string => {
    return override?.trim() || options.path?.trim() || process.env.NANO_DB_PATH?.trim() || path.join(home, "nano.db")
  }
  const requireDatabase = (): Database.Database => {
    if (closed) throw new Error("Persistence service is closed")
    if (!database?.open) throw new Error("Persistence service is not initialized")
    return database
  }
  const requireOutbox = (): WorkerOutbox => {
    requireDatabase()
    if (!outbox) throw new Error("Persistence service outbox is not initialized")
    return outbox
  }
  const requireContextStore = (): ContextStoreService => {
    requireDatabase()
    if (!contextStore) throw new Error("Persistence service context store is not initialized")
    return contextStore
  }
  const requireStateHistory = (): StateHistoryService => {
    requireDatabase()
    if (!stateHistory) throw new Error("Persistence service state history is not initialized")
    return stateHistory
  }
  interface HistoryRow {
    id: number; convId: number; role: string; content: string; toolCalls: string | null; toolCallId: string | null
    createdAt: string; source: string; startedAt: string; tokens: number
  }
  const listHistory = async (input: ConversationHistoryInput): Promise<readonly ConversationHistoryItem[]> => {
    const db = requireDatabase()
    const limit = Math.max(1, Math.min(1000, Math.trunc(input.limit ?? 100) || 100))
    const before = Number.isFinite(input.before) ? Math.trunc(input.before!) : Number.MAX_SAFE_INTEGER
    const lane = input.runtimeKind === "frontend" ? "c.source like 'frontend:%'" : "c.source not like 'frontend:%'"
    const rows = db.prepare<unknown[], HistoryRow>(`select m.id, m.convId, m.role, m.content, m.toolCalls, m.toolCallId, m.createdAt,
      c.source, c.startedAt, c.tokens from messages m join conversations c on c.id = m.convId
      where m.id < ? and ${lane} order by m.id desc limit ?`).all(before, limit)
    return rows.reverse().map((row) => {
      let toolCalls: unknown
      if (row.toolCalls) {
        try { toolCalls = JSON.parse(row.toolCalls) } catch { toolCalls = row.toolCalls }
      }
      return {
        id: row.id, conversationId: row.convId, role: row.role, content: row.content,
        ...(toolCalls === undefined ? {} : { toolCalls }), ...(row.toolCallId === null ? {} : { toolCallId: row.toolCallId }),
        timestamp: Date.parse(row.createdAt), createdAt: row.createdAt, source: row.source, startedAt: row.startedAt, tokens: row.tokens,
      }
    })
  }
  const service: PersistenceService = {
    async init(dbPath) {
      if (closed) throw new Error("Persistence service is closed")
      const targetPath = resolveDatabasePath(dbPath)
      if (database?.open) {
        if (targetPath !== initializedPath) throw new Error("Persistence service is already initialized with a different path")
        return
      }
      if (initializing) {
        if (targetPath !== initializingPath) throw new Error("Persistence service is already initializing with a different path")
        return initializing
      }
      initializingPath = targetPath
      const pending = (async () => {
        const opened = createDatabase(targetPath, home)
        try {
          const history = createStateHistory(opened.db, home)
          const contexts = createContextStore(opened.db)
          const events = createWorkerOutbox(opened.db, { replayTailRows: options.replayTailRows })
          await history.snapshotStateRevisions()
          if (closed) throw new Error("Persistence service was closed during initialization")
          database = opened.db
          vectorAvailable = opened.vecAvailable
          stateHistory = history
          contextStore = contexts
          outbox = events
          initializedPath = targetPath
        } catch (error) {
          if (opened.db.open) opened.db.close()
          throw error
        }
      })()
      initializing = pending
      try {
        await pending
      } finally {
        if (initializing === pending) {
          initializing = undefined
          initializingPath = undefined
        }
      }
    },
    async close() {
      if (closing) return closing
      closed = true
      closing = (async () => {
        await initializing?.catch(() => {})
        const current = database
        outbox = undefined
        stateHistory = undefined
        contextStore = undefined
        database = undefined
        initializedPath = undefined
        vectorAvailable = false
        if (current?.open) current.close()
      })()
      return closing
    },
    get home() { return home },
    getDb: requireDatabase,
    vecAvailable() {
      requireDatabase()
      return vectorAvailable
    },
    startConversation(source, startedAt) {
      return startConversationIn(requireDatabase(), source, startedAt, (type, payload) => requireOutbox().publish(type, payload))
    },
    logMessage(convId, role, content, toolCalls, toolCallId) {
      logMessageIn(requireDatabase(), convId, role, content, toolCalls, toolCallId, (type, payload) => requireOutbox().publish(type, payload))
    },
    endConversation(id, tokens) {
      endConversationIn(requireDatabase(), id, tokens, (type, payload) => requireOutbox().publish(type, payload))
    },
    listConversationHistory: listHistory,
    history: listHistory,
    saveModelSwapHandoff(...args) { requireDatabase(); return sessions.saveModelSwapHandoff(...args) },
    loadModelSwapHandoff(...args) { requireDatabase(); return sessions.loadModelSwapHandoff(...args) },
    clearModelSwapHandoff(...args) { requireDatabase(); return sessions.clearModelSwapHandoff(...args) },
    saveRestSnapshot(...args) { requireDatabase(); return sessions.saveRestSnapshot(...args) },
    loadRestSnapshot(...args) { requireDatabase(); return sessions.loadRestSnapshot(...args) },
    consumeRestSnapshot(...args) { requireDatabase(); return sessions.consumeRestSnapshot(...args) },
    saveSession(...args) { requireDatabase(); return sessions.saveSession(...args) },
    loadSession(...args) { requireDatabase(); return sessions.loadSession(...args) },
    clearSession(...args) { requireDatabase(); return sessions.clearSession(...args) },
    archiveDiscardedSession(...args) { requireDatabase(); return sessions.archiveDiscardedSession(...args) },
    quarantineSession(...args) { requireDatabase(); return sessions.quarantineSession(...args) },
    archiveContextMessages(...args) { return requireContextStore().archiveContextMessages(...args) },
    recordContextCompaction(input) { return requireContextStore().recordContextCompaction(input) },
    recordRestContextSnapshot(...args) { return requireContextStore().recordRestContextSnapshot(...args) },
    grepContext(...args) { return requireContextStore().grepContext(...args) },
    describeContextSummary(...args) { return requireContextStore().describeContextSummary(...args) },
    expandContextSummary(...args) { return requireContextStore().expandContextSummary(...args) },
    listWorkerEvents(afterSeq = 0, limit = 500, mode = "after") { return requireOutbox().list(afterSeq, limit, mode) },
    subscribeWorkerEvents(listener) { return requireOutbox().subscribe(listener) },
    workerEventBounds() { return requireOutbox().bounds() },
    publishWorkerEvent(type, payload) { return requireOutbox().publish(type, payload) },
    async recordStateRevision(filePath, source) {
      await requireStateHistory().recordStateRevision(filePath, source)
    },
  }
  return service
}

export function createPersistencePlugin(defaults: PersistencePluginConfig = {}): Plugin<PersistencePluginConfig> {
  return {
    id: "nano.persistence",
    provides: [nano.persistence],
    validate(raw) {
      if (raw == null) return defaults
      if (typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("nano.persistence config must be an object")
      const value = raw as PersistencePluginConfig
      if (value.path !== undefined && (typeof value.path !== "string" || !value.path.trim())) {
        throw new TypeError("nano.persistence config.path must be a non-empty path")
      }
      if (value.replayTailRows !== undefined && (!Number.isInteger(value.replayTailRows) || value.replayTailRows < 0)) {
        throw new TypeError("nano.persistence config.replayTailRows must be a non-negative integer")
      }
      return { ...defaults, ...value }
    },
    async apply(scope, config) {
      const service = createPersistenceService(config)
      scope.own(() => service.close())
      await service.init(config.path)
      scope.signal.throwIfAborted()
      scope.provide(nano.persistence, service)
    },
  }
}

export const persistencePlugin = createPersistencePlugin()
