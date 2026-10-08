/** Explicitly scoped memory runtime and application service. */
import type Database from "better-sqlite3"
import type { Message } from "../types"
import type { MetricEventInput } from "../metrics"
import type { RuntimeKind } from "../runner/types"
import type { EmbeddingsService } from "../embeddings"
import type { ContextImageReference } from "../context-images"
import type { AgentStateService } from "../agent-state-tools"
import type { AliasMap, DiscordMemorySearchResult, MemorySearchProfile, MemorySearchResult, SemanticQuerySignal } from "./shared"
import { MEMORY_RECALL_COOLDOWN_TURNS, MEMORY_RECALL_MAX_CHUNKS, MEMORY_RECALL_MAX_CHUNKS_HARD_CAP, SCHEDULED_HEARTBEAT_CONTENT, normalizeText, normalizeBodyText, tokensFromText } from "./shared"
import { createAliasService, normalizeHandle, resolveAliases, type AliasService } from "./aliases"
import { createMemoryIndexer, type MemoryIndexer } from "./sync"
import { createMemorySearch, type MemorySearchRuntime } from "./search"
import { createDiscordMemoryQuery, type MemoryQueryRuntime, type MemoryQueryParts, memoryQueryForUserMessage, memoryQueryToString, stripWakeEnvelope } from "./discord-query"

export type { AliasMap, DiscordMemorySearchResult, MemorySearchResult, MemorySearchProfile, SemanticQuerySignal }
export { normalizeBodyText, tokensFromText as searchTokens, normalizeHandle, resolveAliases, memoryQueryForUserMessage, memoryQueryToString, stripWakeEnvelope }
export type { MemoryQueryParts }

export interface MemorySearchOptions {
  readonly searchDiscord?: (query: string, limit: number, queryVector?: number[], runtimeKind?: RuntimeKind) => Promise<readonly DiscordMemorySearchResult[]>
  readonly recordMetric?: (event: MetricEventInput) => void
  readonly memoryExcerptImageReferences?: (text: string, path: string) => Promise<ContextImageReference[]>
  readonly signal?: AbortSignal
  readonly runtimeKind?: RuntimeKind
}

export interface MemoryRuntimeDependencies {
  readonly home: string
  readonly persistence: { readonly getDb: () => Database.Database; readonly vecAvailable: () => boolean }
  readonly embeddings?: EmbeddingsService
  readonly searchDiscord?: MemorySearchOptions["searchDiscord"]
  readonly recordMetric?: MemorySearchOptions["recordMetric"]
  readonly memoryExcerptImageReferences?: MemorySearchOptions["memoryExcerptImageReferences"]
}

export interface MemoryRuntime {
  readonly home: string
  readonly indexer: MemoryIndexer
  readonly searchRuntime: MemorySearchRuntime
  readonly queryRuntime: MemoryQueryRuntime
  readonly aliases: AliasService
  syncMemoryIndex(): Promise<void>
  buildCompletionMessages(conversation: readonly Message[], cooldowns: Record<number, number>, currentTurn: number, options?: MemorySearchOptions): Promise<{ messages: Message[]; recalledChunkIds: number[] }>
  searchMemories(rawQuery: string, limit?: number, runtimeKind?: RuntimeKind, options?: MemorySearchOptions): Promise<MemorySearchResult[]>
  rememberRecalledMemoryChunks(cooldowns: Record<number, number>, injectedChunkIds: readonly number[], currentTurn: number): Record<number, number>
}

export interface MemoryApplicationService extends AgentStateService {
  readonly search: MemoryRuntime["searchMemories"]
  readonly recall: MemoryRuntime["buildCompletionMessages"]
  readonly remember: MemoryRuntime["rememberRecalledMemoryChunks"]
  readonly syncMemoryIndex: MemoryRuntime["syncMemoryIndex"]
  readonly listAliases: AliasService["listAliases"]
  readonly setAlias: AliasService["setAlias"]
  readonly removeAlias: AliasService["removeAlias"]
}

function isMemoryRecallSkippedMessage(content: string, query: MemoryQueryRuntime): boolean {
  if (content.startsWith("[memory recall")) return true
  if (content.startsWith("[system]")) return true
  if (content.includes("scan snapshot:") && !content.includes("[discord batch]")) return true
  if (/\[discord batch\]/i.test(content) && query.conciseDiscordBatchMemoryQuery(content) === null) return true
  return false
}

function latestMemoryRecallQuery(conversation: readonly Message[], query: MemoryQueryRuntime): string | null {
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    const message = conversation[i]
    if (!message || message.role !== "user" || typeof message.content !== "string") continue
    const content = message.content.trim()
    if (!content || isMemoryRecallSkippedMessage(content, query) || content === SCHEDULED_HEARTBEAT_CONTENT) continue
    return content
  }
  return null
}


export function createMemoryRuntime(deps: MemoryRuntimeDependencies): MemoryRuntime {
  const db = deps.persistence.getDb()
  const aliases = createAliasService({ home: deps.home })
  const searchRuntime = createMemorySearch({ home: deps.home, db, vecAvailable: deps.persistence.vecAvailable(), embeddings: deps.embeddings, aliases })
  const indexer = createMemoryIndexer({ home: deps.home, db, vecAvailable: deps.persistence.vecAvailable(), embeddings: deps.embeddings })
  const queryRuntime = createDiscordMemoryQuery({ db })

  async function buildCompletionMessages(conversation: readonly Message[], cooldowns: Record<number, number>, currentTurn: number, options: MemorySearchOptions = {}) {
    const source = latestMemoryRecallQuery(conversation, queryRuntime)
    if (!source) return { messages: [...conversation], recalledChunkIds: [] }
    const parts = queryRuntime.memoryQueryForUserMessage(source)
    const memoryQuery = queryRuntime.memoryQueryToString(parts)
    await indexer.syncMemoryIndex()
    const profile = await searchRuntime.buildSearchProfile(parts)
    if (profile.tokens.length === 0) return { messages: [...conversation], recalledChunkIds: [] }
    let semanticSignal: SemanticQuerySignal | null = null
    try { semanticSignal = await searchRuntime.semanticQuerySignal(memoryQuery, options.signal) } catch (error) { console.warn(`[memory] semantic query failed: ${error instanceof Error ? error.message : String(error)}`) }
    if (searchRuntime.shouldSkipForSemanticChatter(profile, semanticSignal)) return { messages: [...conversation], recalledChunkIds: [] }
    const personCount = (profile.sender ? 1 : 0) + profile.bodyPeople.length
    const recallLimit = Math.min(MEMORY_RECALL_MAX_CHUNKS_HARD_CAP, personCount >= 2 ? MEMORY_RECALL_MAX_CHUNKS + personCount - 1 : MEMORY_RECALL_MAX_CHUNKS)
    const hits = await searchRuntime.searchMemory(profile, cooldowns, currentTurn, recallLimit, semanticSignal)
    const searchDiscord = options.searchDiscord ?? deps.searchDiscord
    const discordResults = searchDiscord ? await searchDiscord(memoryQuery, recallLimit, semanticSignal?.vector, options.runtimeKind ?? "main") : []
    if (hits.length === 0 && discordResults.length === 0) return { messages: [...conversation], recalledChunkIds: [] }
    const includeAuthoredHits = hits.length > 0 && searchRuntime.isRelevant(hits, profile)
    if (!includeAuthoredHits && discordResults.length === 0) return { messages: [...conversation], recalledChunkIds: [] }
    const recallContent = [includeAuthoredHits ? searchRuntime.buildMemoryRecallMessage(hits) : "", discordResults.length ? discordResults.map((result) => `- ${result.source}\n  ${normalizeText(result.content)}`).join("\n") : ""].filter(Boolean).join("\n")
    const recordMetric = options.recordMetric ?? deps.recordMetric
    recordMetric?.({ type: "memory", query: memoryQuery, results: [...(includeAuthoredHits ? hits.map(searchRuntime.toMemorySearchResult) : []), ...discordResults] })
    const imageRefs = options.memoryExcerptImageReferences ?? deps.memoryExcerptImageReferences
    const imageReferences = imageRefs ? (await Promise.all(hits.map((hit) => imageRefs(hit.text, hit.path)))).flat() : []
    const recallMessage: Message = { role: "user", content: recallContent, imageReferences, timestamp: Date.now() }
    return { messages: [...conversation, recallMessage], recalledChunkIds: includeAuthoredHits ? hits.map((hit) => hit.chunkId) : [] }
  }

  async function searchMemories(rawQuery: string, limit = 5, runtimeKind: RuntimeKind = "main", options: MemorySearchOptions = {}) {
    await indexer.syncMemoryIndex()
    const profile = await searchRuntime.buildSearchProfile({ sender: null, source: null, body: rawQuery })
    if (profile.tokens.length === 0) return []
    let semanticSignal: SemanticQuerySignal | null = null
    try { semanticSignal = await searchRuntime.semanticQuerySignal(rawQuery, options.signal) } catch { semanticSignal = null }
    const boundedLimit = Math.max(1, Math.min(limit, 10))
    const authoredHits = await searchRuntime.searchMemory(profile, {}, Number.POSITIVE_INFINITY, boundedLimit, semanticSignal, true)
    const searchDiscord = options.searchDiscord ?? deps.searchDiscord
    const discordResults = searchDiscord ? await searchDiscord(rawQuery, boundedLimit, semanticSignal?.vector, runtimeKind) : []
    const candidates: Array<{ result: MemorySearchResult; similarity: number; ordinal: number }> = [...authoredHits.map((hit, ordinal) => ({ result: searchRuntime.toMemorySearchResult(hit), similarity: hit.semanticSimilarity ?? 0.5, ordinal })), ...discordResults.map((result, ordinal) => ({ result, similarity: result.semanticSimilarity, ordinal }))]
    candidates.sort((a, b) => b.similarity - a.similarity || a.ordinal - b.ordinal)
    const results = candidates.slice(0, boundedLimit).map(({ result }) => result)
    ;(options.recordMetric ?? deps.recordMetric)?.({ type: "memory", query: rawQuery, results })
    return results
  }

  function rememberRecalledMemoryChunks(cooldowns: Record<number, number>, injectedChunkIds: readonly number[], currentTurn: number) {
    const next = { ...cooldowns }
    for (const chunkId of injectedChunkIds) next[chunkId] = currentTurn
    for (const [chunkId, turn] of Object.entries(next)) if (currentTurn - turn >= MEMORY_RECALL_COOLDOWN_TURNS * 2) delete next[Number(chunkId)]
    return next
  }

  return { home: deps.home, indexer, searchRuntime, queryRuntime, aliases, syncMemoryIndex: indexer.syncMemoryIndex, buildCompletionMessages, searchMemories, rememberRecalledMemoryChunks }
}

export function createMemoryApplicationService(runtime: MemoryRuntime, agentState: AgentStateService): MemoryApplicationService {
  return { ...agentState, search: runtime.searchMemories, recall: runtime.buildCompletionMessages, remember: runtime.rememberRecalledMemoryChunks, syncMemoryIndex: runtime.syncMemoryIndex, listAliases: runtime.aliases.listAliases, setAlias: runtime.aliases.setAlias, removeAlias: runtime.aliases.removeAlias }
}

export const __memoryTest = { latestMemoryRecallQuery: (conversation: readonly Message[]) => latestMemoryRecallQuery(conversation, createDiscordMemoryQuery({})) }
