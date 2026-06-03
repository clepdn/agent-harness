/**
 * Reply context extraction from Discord message payloads.
 *
 * Pure JSON parsing — no database access.
 *
 * @module discord/reply-context
 */

import { getDb } from "../db"
import { asObject, asString } from "./parse"

// ── types ──────────────────────────────────────────────────────────────

export type DiscordReplyContext = {
  message_id: string
  author_id: string | null
  author_username: string | null
  content: string
}

// ── extraction ─────────────────────────────────────────────────────────

/**
 * Extracts the referenced (replied-to) message id from raw JSON.
 *
 * @param rawJson - Stored raw JSON for a Discord message.
 * @returns Referenced message id, or `null`.
 */
export function extractReferencedMessageId(rawJson: string): string | null {
  try {
    const root = asObject(JSON.parse(rawJson))
    if (!root) return null
    const message = asObject(root.message) ?? root
    const reference =
      asObject(message.message_reference) ??
      asObject(root.message_reference) ??
      asObject(message.reference) ??
      asObject(root.reference)

    const direct =
      asString(reference?.message_id) ??
      asString(reference?.messageId) ??
      asString(reference?.id)
    if (direct) return direct

    const referencedMessage = asObject(message.referenced_message) ?? asObject(root.referenced_message)
    return asString(referencedMessage?.id)
  } catch {
    return null
  }
}

/**
 * Extracts an embedded referenced message from raw JSON (for messages that include it inline).
 *
 * @param rawJson - Stored raw JSON for a Discord message.
 * @returns Parsed reply context, or `null`.
 */
export function extractEmbeddedReferencedMessage(rawJson: string): DiscordReplyContext | null {
  try {
    const root = asObject(JSON.parse(rawJson))
    if (!root) return null
    const message = asObject(root.message) ?? root
    const referenced = asObject(message.referenced_message) ?? asObject(root.referenced_message)
    if (!referenced) return null

    const messageId = asString(referenced.id)
    if (!messageId) return null

    const author = asObject(referenced.author)
    return {
      message_id: messageId,
      author_id: asString(author?.id),
      author_username: asString(author?.username ?? author?.global_name),
      content: String(referenced.content ?? ""),
    }
  } catch {
    return null
  }
}

/**
 * Builds a map of message id → reply context for a set of messages that may reference others.
 *
 * This function does touch the database to look up referenced messages that aren't
 * embedded in the payload, but the core logic is about assembling the context map.
 *
 * @param rows - Messages with raw_json to scan for references.
 * @returns Map from message id to the reply target context.
 */
export function buildReplyTargetContextMap(rows: Array<{ message_id: string; raw_json: string }>): Map<string, DiscordReplyContext> {
  const refsByMessage = new Map<string, { refId: string; embedded: DiscordReplyContext | null }>()
  for (const row of rows) {
    const refId = extractReferencedMessageId(row.raw_json)
    if (refId) refsByMessage.set(row.message_id, { refId, embedded: extractEmbeddedReferencedMessage(row.raw_json) })
  }

  if (refsByMessage.size === 0) return new Map()

  const refIds = Array.from(new Set([...refsByMessage.values()].map((ref) => ref.refId)))
  const db = getDb()
  const placeholders = refIds.map(() => "?").join(", ")
  const targetRows = db
    .prepare(
      `select message_id, author_id, author_username, content
       from discord_messages
       where message_id in (${placeholders})`,
    )
    .all(...refIds) as DiscordReplyContext[]

  const contextById = new Map<string, DiscordReplyContext>()
  for (const row of targetRows) {
    contextById.set(row.message_id, row)
  }

  const out = new Map<string, DiscordReplyContext>()
  for (const [messageId, ref] of refsByMessage.entries()) {
    const fallback = ref.embedded ?? {
      message_id: ref.refId,
      author_id: null,
      author_username: null,
      content: "",
    }
    out.set(messageId, contextById.get(ref.refId) ?? fallback)
  }

  return out
}
