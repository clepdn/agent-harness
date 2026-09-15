/**
 * Memory system public API.
 *
 * Re-exports the surface used by the rest of the codebase:
 * - `buildCompletionMessages` — recall pipeline for the runner loop
 * - `searchMemories` — explicit tool-triggered search
 * - `rememberRecalledMemoryChunks` — cooldown tracking
 * - `listAliases`, `setAlias`, `removeAlias` — alias CRUD
 * - `__memoryTest` — test-only internals
 *
 * @module memory
 */

import type { Message } from "../types"
import { recordMetric } from "../metrics"
import { syncMemoryIndex } from "./sync"
import { markdownExcerptImageReferences } from "../context-images"
import { searchDiscordMemoryEntries } from "../discord/search"
import type { RuntimeKind } from "../runner/types"
import {
  MEMORY_RECALL_COOLDOWN_TURNS,
  MEMORY_RECALL_MAX_CHUNKS,
  MEMORY_RECALL_MAX_CHUNKS_HARD_CAP,
  MEMORY_RECALL_INTENT_SIMILARITY_THRESHOLD,
  normalizeText,
  SCHEDULED_HEARTBEAT_CONTENT,
  trimForPrompt,
  type MemorySearchResult,
} from "./shared"
import {
  buildSearchProfile,
  semanticQuerySignal,
  shouldSkipForSemanticChatter,
  searchMemory,
  isRelevant,
  buildMemoryRecallMessage,
  toMemorySearchResult,
} from "./search"
import {
  memoryQueryForUserMessage,
  memoryQueryToString,
} from "./discord-query"

export { listAliases, setAlias, removeAlias, normalizeHandle } from "./aliases"
export { resolveAliases } from "./aliases"
export { syncMemoryIndex } from "./sync"
export { memoryQueryForUserMessage, stripWakeEnvelope } from "./discord-query"
export { normalizeBodyText, tokensFromText as searchTokens } from "./shared"
export { buildSearchProfile } from "./search"
export type { AliasMap, MemorySearchResult } from "./shared"

// ── recall pipeline ────────────────────────────────────────────────────

function isMemoryRecallSkippedMessage(content: string): boolean {
  if (content.startsWith("[memory recall")) return true
  if (content.startsWith("[system]")) return true
  if (content.includes("scan snapshot:") && !content.includes("[discord batch]")) return true
  if (/\[discord batch\]/i.test(content) && conciseDiscordBatchMemoryQuery(content) === null) return true
  return false
}

function latestMemoryRecallQuery(conversation: Message[]): string | null {
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    const message = conversation[i]
    if (!message || message.role !== "user") continue
    if (typeof message.content !== "string") continue

    const content = message.content.trim()
    if (!content || isMemoryRecallSkippedMessage(content)) continue
    if (content === SCHEDULED_HEARTBEAT_CONTENT) continue
    return content
  }
  return null
}

// Need this import for isMemoryRecallSkippedMessage
import { conciseDiscordBatchMemoryQuery } from "./discord-query"

/**
 * Runs the memory recall pipeline: extracts a query, searches, gates, and formats.
 *
 * @param conversation - Current conversation messages.
 * @param cooldowns - Chunk id → last-recalled turn mapping.
 * @param currentTurn - Current conversation turn number.
 * @returns Updated messages (with recall injected) and recalled chunk ids.
 */
export async function buildCompletionMessages(
  conversation: Message[],
  cooldowns: Record<number, number>,
  currentTurn: number,
): Promise<{ messages: Message[]; recalledChunkIds: number[] }> {
  const memoryQuerySource = latestMemoryRecallQuery(conversation)
  if (!memoryQuerySource) return { messages: conversation, recalledChunkIds: [] }
  const queryParts = memoryQueryForUserMessage(memoryQuerySource)
  const memoryQuery = memoryQueryToString(queryParts)

  await syncMemoryIndex()

  const profile = await buildSearchProfile(queryParts)
  if (profile.tokens.length === 0) return { messages: conversation, recalledChunkIds: [] }

  let semanticSignal: import("./shared").SemanticQuerySignal | null = null
  try {
    semanticSignal = await semanticQuerySignal(memoryQuery)
  } catch (err: any) {
    console.warn(`[memory] semantic query failed: ${err?.message ?? String(err)}`)
  }

  if (shouldSkipForSemanticChatter(profile, semanticSignal)) {
    console.log(
      `[memory] skipped query=${JSON.stringify(trimForPrompt(normalizeText(memoryQuery), 120))} sender=${profile.sender ?? "-"} reason=semantic-chatter chatter=${semanticSignal?.chatterSimilarity?.toFixed(3) ?? "-"} recallIntent=${semanticSignal?.recallIntentSimilarity?.toFixed(3) ?? "-"}`,
    )
    return { messages: conversation, recalledChunkIds: [] }
  }

  const hasSemanticRecallIntent =
    (semanticSignal?.recallIntentSimilarity ?? 0) >= MEMORY_RECALL_INTENT_SIMILARITY_THRESHOLD

  if ((profile.sender || profile.bodyPeople.length > 0) && !profile.bodyInformative && !hasSemanticRecallIntent) {
    console.log(
      `[memory] skipped query=${JSON.stringify(trimForPrompt(normalizeText(memoryQuery), 120))} sender=${profile.sender ?? "-"} reason=trivial-body`,
    )
    return { messages: conversation, recalledChunkIds: [] }
  }

  const personCount = [...(profile.sender ? [profile.sender] : []), ...profile.bodyPeople].length
  const recallLimit = Math.min(
    MEMORY_RECALL_MAX_CHUNKS_HARD_CAP,
    personCount >= 2 ? MEMORY_RECALL_MAX_CHUNKS + (personCount - 1) : MEMORY_RECALL_MAX_CHUNKS,
  )
  const hits = await searchMemory(profile, cooldowns, currentTurn, recallLimit, semanticSignal)
  const aliasInfo = profile.senderAliases.length > 0 ? ` aliases=${profile.senderAliases.join(",")}` : ""
  const peopleInfo = profile.bodyPeople.length > 0 ? ` people=${profile.bodyPeople.join(",")}` : ""
  const debugTag = `sender=${profile.sender ?? "-"}${aliasInfo}${peopleInfo} personQuery=${profile.personQuery} eventQuery=${profile.eventQuery}`
  if (hits.length === 0) {
    console.log(
      `[memory] no-hits query=${JSON.stringify(trimForPrompt(normalizeText(memoryQuery), 120))} ${debugTag}`,
    )
    return { messages: conversation, recalledChunkIds: [] }
  }
  if (!isRelevant(hits, profile)) {
    console.log(
      `[memory] skipped query=${JSON.stringify(trimForPrompt(normalizeText(memoryQuery), 120))} ${debugTag} reason=weak-match`,
    )
    return { messages: conversation, recalledChunkIds: [] }
  }

  const recallContent = buildMemoryRecallMessage(hits)
  console.log(
    `[memory] recalled query=${JSON.stringify(trimForPrompt(normalizeText(memoryQuery), 120))} ${debugTag}\n${recallContent}`,
  )

  recordMetric({
    type: "memory",
    query: memoryQuery,
    results: hits.map(toMemorySearchResult),
  })

  const recallMessage: Message = {
    role: "user",
    content: recallContent,
    imageReferences: (await Promise.all(hits.map((hit) => markdownExcerptImageReferences(hit.text, hit.path)))).flat(),
    timestamp: Date.now(),
  }

  return {
    messages: [...conversation, recallMessage],
    recalledChunkIds: hits.map((hit) => hit.chunkId),
  }
}

/**
 * Updates cooldown tracking with newly recalled chunk ids and prunes stale entries.
 *
 * @param cooldowns - Current cooldown map.
 * @param injectedChunkIds - Chunk ids just injected.
 * @param currentTurn - Current conversation turn number.
 * @returns Updated cooldown map.
 */
export function rememberRecalledMemoryChunks(
  cooldowns: Record<number, number>,
  injectedChunkIds: number[],
  currentTurn: number,
): Record<number, number> {
  const next = { ...cooldowns }
  for (const chunkId of injectedChunkIds) next[chunkId] = currentTurn

  for (const [chunkId, turn] of Object.entries(next)) {
    if (currentTurn - turn >= MEMORY_RECALL_COOLDOWN_TURNS * 2) delete next[Number(chunkId)]
  }

  return next
}

/**
 * Explicit tool-triggered memory search.
 *
 * @param rawQuery - Search query string.
 * @param limit - Maximum results (default 5, max 10).
 * @returns Search results.
 */
export async function searchMemories(rawQuery: string, limit = 5, runtimeKind: RuntimeKind = "main"): Promise<MemorySearchResult[]> {
  await syncMemoryIndex()

  const profile = await buildSearchProfile({ sender: null, source: null, body: rawQuery })
  if (profile.tokens.length === 0) return []

  let semanticSignal: import("./shared").SemanticQuerySignal | null = null
  try {
    semanticSignal = await semanticQuerySignal(rawQuery)
  } catch {
    semanticSignal = null
  }

  const boundedLimit = Math.max(1, Math.min(limit, 10))
  const authoredHits = await searchMemory(
    profile,
    {},
    Number.POSITIVE_INFINITY,
    boundedLimit,
    semanticSignal,
    true,
  )
  let discordResults: import("./shared").DiscordMemorySearchResult[] = []
  try {
    discordResults = await searchDiscordMemoryEntries(rawQuery, boundedLimit, semanticSignal?.vector, runtimeKind)
  } catch (err: any) {
    console.warn(`[memory] Discord vector search failed: ${err?.message ?? String(err)}`)
  }
  const candidates: Array<{ result: MemorySearchResult; similarity: number; ordinal: number }> = [
    ...authoredHits.map((hit, ordinal) => ({
      result: toMemorySearchResult(hit),
      similarity: hit.semanticSimilarity ?? 0.5,
      ordinal,
    })),
    ...discordResults.map((result, ordinal) => ({ result, similarity: result.semanticSimilarity, ordinal })),
  ]
  candidates.sort((a, b) => b.similarity - a.similarity || a.ordinal - b.ordinal)
  const results = candidates.slice(0, boundedLimit).map(({ result }) => result)
  recordMetric({
    type: "memory",
    query: rawQuery,
    results,
  })
  return results
}

// ── test exports ───────────────────────────────────────────────────────

export const __memoryTest = {
  latestMemoryRecallQuery,
}
