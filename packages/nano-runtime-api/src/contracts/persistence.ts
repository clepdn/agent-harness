import type { ToolDefinition } from "@nano/harness-core"
import type { ContextEffortState, ContextForkReason, Message } from "../llm"
import type { DiscordMessageTarget, UserMessage } from "../types"
import type { RuntimeKind } from "./runner"

export type ModelSwapHandoff = {
  version: 1
  preset: string
  id?: string
  eventIds?: string[]
  messages: Message[]
  events: UserMessage[]
  note: string
  phase?: "closing" | "selected"
  frontendMessages?: Message[]
  frontendEvents?: UserMessage[]
  frontendId?: string
  frontendEventIds?: string[]
}

export interface RestSnapshot {
  restedAt: string
  note?: string
  summary: string
}

export type SessionSnapshot = {
  version: 1
  messages: Message[]
  toolCatalog: ToolDefinition[]
  toolCatalogEpoch: number
  toolCatalogFingerprint: string
  contextId?: string
  parentContextId?: string
  contextForkReason?: ContextForkReason
  contextConfigurationFingerprint?: string
  contextModelId?: string
  contextEffortState?: ContextEffortState
  discordTargets?: DiscordMessageTarget[]
  modelSwapHandoffId?: string
  modelSwapEventIds?: string[]
}

export interface SessionStore {
  saveModelSwapHandoff(handoff: ModelSwapHandoff): Promise<void>
  loadModelSwapHandoff(): Promise<ModelSwapHandoff | null>
  clearModelSwapHandoff(): Promise<void>
  saveRestSnapshot(messages: readonly Message[], note?: string, kind?: RuntimeKind, summaryOverride?: string): Promise<void>
  loadRestSnapshot(kind?: RuntimeKind): Promise<RestSnapshot | null>
  consumeRestSnapshot(kind?: RuntimeKind): Promise<RestSnapshot | null>
  saveSession(snapshot: SessionSnapshot, kind?: RuntimeKind): Promise<void>
  loadSession(kind?: RuntimeKind): Promise<SessionSnapshot | null>
  clearSession(kind?: RuntimeKind): Promise<void>
  archiveDiscardedSession(snapshot: SessionSnapshot, kind?: RuntimeKind): Promise<string>
  quarantineSession(kind?: RuntimeKind): Promise<string[]>
}

export type ContextSearchResult = {
  messageId: string
  role: string
  content: string
  firstSeenAt: string
  source: string
  summaryIds: string[]
}

export type ContextExpansion = {
  summaryId: string
  summary: string
  method: string
  createdAt: string
  totalMessages: number
  offset: number
  limit: number
  messages: Array<{ id: string; role: string; content: unknown; firstSeenAt: string; source: string }>
}

export type ContextSourceStats = {
  messageCount: number
  estimatedTokens: number
  roleCounts: Record<string, number>
  earliestAt: string | null
  latestAt: string | null
}

export type ContextSummaryDescription = {
  id: string
  type: "summary"
  summary: {
    content: string
    method: string
    createdAt: string
    parentIds: string[]
    childIds: string[]
    provenanceDepth: number
    provenanceNodeCount: number
    directSources: ContextSourceStats
    expandedSources: ContextSourceStats
    manifest: Array<{
      summaryId: string
      parentSummaryId: string | null
      depthFromRoot: number
      method: string
      createdAt: string
      directSources: ContextSourceStats
      expandedSources: ContextSourceStats
      expansionFitsTokenCap: boolean
    }>
  }
  expansion: {
    tool: "context_expand"
    totalMessages: number
    defaultPageSize: number
    maxPageSize: number
    estimatedPages: number
    tokenCap: number
  }
}

export interface ContextStoreService {
  archiveContextMessages(messages: readonly Message[], source: string, runtimeKind?: RuntimeKind): string[]
  recordContextCompaction(input: { summaryText: string; compactedMessages: Message[]; priorSummaryContent?: string | null; method: string; runtimeKind?: RuntimeKind }): string
  recordRestContextSnapshot(messages: Message[], note?: string, runtimeKind?: RuntimeKind): { summaryId: string; forest: string; sourceCount: number }
  grepContext(query: string, limit?: number, summaryId?: string, runtimeKind?: RuntimeKind): ContextSearchResult[]
  describeContextSummary(summaryId: string, tokenCap?: number, runtimeKind?: RuntimeKind): ContextSummaryDescription | null
  expandContextSummary(summaryId: string, offset?: number, limit?: number, runtimeKind?: RuntimeKind): ContextExpansion | null
}
