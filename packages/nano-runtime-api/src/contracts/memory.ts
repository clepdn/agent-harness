import type { Message } from "../llm"
import type { ContextImageReference } from "./images"
import type { MetricEventInput } from "./metrics"
import type { RuntimeKind } from "./runner"

export type MemoryKind = "core" | "journal" | "people"

export type AuthoredMemorySearchResult = {
  /** Stable model-facing id for this indexed memory chunk. */
  id: `memory:${number}`
  chunkId: number
  kind: MemoryKind
  /** Stable model-facing source URI. Edit this resource to correct or expunge a result. */
  uri: string
  /** SHA-1 of the indexed source document. Changes whenever the source changes. */
  documentHash: string
  source: string
  title: string
  headingPath: string | null
  /** Exact source text suitable for an exact replacement/deletion. */
  content: string
  preview: string
  semanticSimilarity?: number
}

export type DiscordMemorySearchResult = {
  /** Stable model-facing id accepted by memory_prune. */
  id: `discord:${string}`
  kind: "discord"
  messageId: string
  channelId: string
  guildId: string | null
  guildName: string | null
  channelName: string | null
  authorId: string | null
  authorUsername: string | null
  createdAt: string
  source: string
  content: string
  preview: string
  semanticSimilarity: number
}

export type MemorySearchResult = AuthoredMemorySearchResult | DiscordMemorySearchResult
export type AliasMap = Record<string, string[]>

export type MemorySearchProfile = {
  normalized: string
  sender: string | null
  senderAliases: string[]
  bodyTokens: string[]
  bodyPeople: string[]
  tokens: string[]
  personQuery: boolean
  eventQuery: boolean
  bodyInformative: boolean
}

export type SemanticQuerySignal = {
  vector: number[]
  chatterSimilarity: number | null
  recallIntentSimilarity: number | null
}

export type MemoryQueryParts = {
  sender: string | null
  source: string | null
  body: string
}

export interface AgentStateDependencies {
  readonly home: string
  readonly readClientFile: (path: string, maxBytes?: number, timeoutMs?: number) => Promise<{ path: string; name: string; mime: string; data: Buffer }>
  readonly persistence: { readonly recordStateRevision: (filePath: string, source: string) => Promise<void> }
  readonly bootstrap: {
    readonly readFrontendSoul: () => Promise<string>
    readonly writeFrontendSoul: (expectedSoul: string, content: string) => Promise<{ patchPath: string; conflicted: boolean }>
  }
  readonly syncMemoryIndex: () => Promise<void>
}

export interface MemoryQueryRuntime {
  memoryQueryForUserMessage(raw: string): MemoryQueryParts
  conciseDiscordMemoryQuery(raw: string): MemoryQueryParts | null
  conciseDiscordBatchMemoryQuery(raw: string): MemoryQueryParts | null
  memoryQueryToString(parts: MemoryQueryParts): string
  stripWakeEnvelope(raw: string): string
}

export type MemoryAccessOptions = {
  excludeSkills?: boolean
  excludeMainSessionArchives?: boolean
  allowLocalCopy?: boolean
  /** Present memory://soul.md as a private patch over the main soul. */
  virtualizeSoul?: boolean
  /** Include hashline anchors when displaying memory file contents. */
  hashline?: boolean
}

export interface AgentStateService {
  memoryFs(fileName: unknown, rawOperation: unknown, rawTarget?: unknown, options?: MemoryAccessOptions): Promise<string>
  readMemory(relativePath: unknown, startLine?: unknown, endLine?: unknown, options?: MemoryAccessOptions): Promise<string>
  listMemory(options?: MemoryAccessOptions): Promise<string>
  grepMemory(query: unknown, caseInsensitive?: unknown, options?: MemoryAccessOptions): Promise<string>
  editMemoryResource(uri: unknown, oldText: unknown, newText: unknown, expectedHash?: unknown, options?: MemoryAccessOptions): Promise<string>
  editMemoryResourceHashline(uri: unknown, edits: unknown, expectedHash?: unknown, options?: MemoryAccessOptions): Promise<string>
  writeMemory(relativePath: unknown, content: unknown, mode: unknown, target?: unknown, expectedHash?: unknown): Promise<string>
  writeSoul(content: unknown, mode: unknown, target?: unknown): Promise<string>
  loadSkill(name: unknown): Promise<string>
}

export interface MemorySearchOptions {
  readonly searchDiscord?: (query: string, limit: number, queryVector?: number[], runtimeKind?: RuntimeKind) => Promise<readonly DiscordMemorySearchResult[]>
  readonly recordMetric?: (event: MetricEventInput) => void
  readonly memoryExcerptImageReferences?: (text: string, path: string) => Promise<ContextImageReference[]>
  readonly signal?: AbortSignal
  readonly runtimeKind?: RuntimeKind
}

export interface MemoryApplicationService extends AgentStateService {
  readonly search: (rawQuery: string, limit?: number, runtimeKind?: RuntimeKind, options?: MemorySearchOptions) => Promise<MemorySearchResult[]>
  readonly recall: (conversation: readonly Message[], cooldowns: Record<number, number>, currentTurn: number, options?: MemorySearchOptions) => Promise<{ messages: Message[]; recalledChunkIds: number[] }>
  readonly remember: (cooldowns: Record<number, number>, injectedChunkIds: readonly number[], currentTurn: number) => Record<number, number>
  readonly syncMemoryIndex: () => Promise<void>
  readonly listAliases: () => Promise<AliasMap>
  readonly setAlias: (handle: string, canonical: string) => Promise<AliasMap>
  readonly removeAlias: (handle: string, canonical?: string) => Promise<AliasMap>
}
