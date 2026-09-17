import type { DiscordMessageTarget, UserMessage, RunnerState } from "../types"
import type { Context } from "../llm"
import type { ClientToolExecutor, ToolDefinition } from "@nano/harness-core"

export type CompactionResult = "none" | "rewritten" | "suppressed"
export type RuntimeKind = "main" | "frontend"

/** Options carried from the Discord /compact command to the idle loop. */
export interface ManualCompactionRequest {
  /** Require the dedicated [summary] model instead of the active generation model. */
  forceSummaryModel: boolean
  /** Preserve the discarded span in a snapcompact bitmap frame when possible. */
  snapcompact: boolean
}

export type ImageDetail = "auto" | "low" | "high"

/** Mutable state consumed by the runner loop on each turn. */
export interface LoopState {
  /** Which virtual agent owns this independent conversation loop. */
  runtimeKind?: RuntimeKind
  context: Context
  pendingInputs: UserMessage[]
  tokenCount: number
  contextSize: number
  /** Tool definitions pinned for this session/catalog epoch. */
  toolCatalog: ToolDefinition[]
  /** Monotonic catalog epoch, incremented only at session/rewrite boundaries. */
  toolCatalogEpoch: number
  /** Canonical serialization fingerprint guarding against in-place mutation. */
  toolCatalogFingerprint: string
  toolInFlight: boolean
  memoryRecallCooldowns: Record<number, number>
  memoryRecallTurn: number
  /**
   * True only on the first assistant step after a new incoming event. Memory
   * recall runs once per turn rather than on every agentic iteration so it
   * doesn't flood context while the assistant works through a single turn.
   */
  memoryRecallPending: boolean
  shutdownRequested: boolean
  turnInFlight: boolean
  /** Signal for the generation/tool chain currently occupying the main loop. */
  operationSignal?: AbortSignal
  /** Controller retained by the root runner so slash commands can abort it. */
  activeTurnController?: AbortController
  /** Set by /interrupt until the current generation/tool chain unwinds. */
  interruptRequested?: boolean
  /** Set by /discard until the active session has been archived and removed. */
  discardRequested?: boolean
  /** When true, the loop exits with "rest" at the next turn boundary. */
  restRequested: boolean
  /** Reason for the programmatic rest (e.g. model swap). */
  restReason: string
  /** Pending operator-requested compaction, always run regardless of token count. */
  compactionRequest?: ManualCompactionRequest
  /** Stable outbound Discord response scope across tool-producing iterations. */
  discordTypingTurnId?: string
  discordTypingChannelId?: string
  /** Rolling registry of the 16 most recently surfaced Discord message targets. */
  discordTargets?: DiscordMessageTarget[]
}

/** Lifecycle hooks injected by the runner orchestrator into the loop. */
export interface LoopHooks {
  /** Marks model work as active, ending the preceding quiet interval. */
  onTurnStart?: () => void
  /** Waits for the next incoming event from any trigger source. */
  waitForEvent: () => Promise<UserMessage | null>
  /** Waits up to timeoutMs for the next event; resolves null on timeout. */
  waitForEventWithTimeout: (timeoutMs: number) => Promise<UserMessage | null>
  /** Injects an incoming event into the in-memory conversation. */
  injectIncomingEvent: (convId: number, event: UserMessage) => void
  /** Flushes events deferred while a tool call was in flight. */
  flushDeferredEvents: () => void
  clientTools?: ClientToolExecutor
  refreshToolCatalog: (reason: "post-compaction") => void
  clearSession: () => Promise<void>
  saveSession: () => Promise<void>
  saveShutdownSnapshot: () => Promise<void>
  shouldShutdown: () => boolean
  resolveShutdown: () => void
}

export interface RunnerStateInternal extends RunnerState {
  runtimeKind: RuntimeKind
  toolCatalog: ToolDefinition[]
  toolCatalogEpoch: number
  toolCatalogFingerprint: string
  toolInFlight: boolean
  shutdownRequested: boolean
  turnInFlight: boolean
  activeTurnController?: AbortController
  operationSignal?: AbortSignal
  interruptRequested?: boolean
  discardRequested?: boolean
  deferredEvents: Array<{ event: UserMessage; priority: boolean }>
  restRequested: boolean
  restReason: string
  compactionRequest?: ManualCompactionRequest
  discordTypingTurnId?: string
  discordTypingChannelId?: string
  discordTargets?: DiscordMessageTarget[]
}
