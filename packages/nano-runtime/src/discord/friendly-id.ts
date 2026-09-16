import { randomInt } from "node:crypto"
import { getDb } from "../db"

const PLANTS = [
  "alder", "bamboo", "basil", "birch", "cactus", "cedar",
  "clover", "daisy", "elm", "fern", "hazel", "heather",
  "holly", "iris", "ivy", "jasmine", "juniper", "lavender",
  "lilac", "lily", "lotus", "maple", "mint", "moss",
  "oak", "olive", "orchid", "palm", "pine", "poppy",
  "reed", "rose", "sage", "tulip", "wheat", "willow",
] as const

const OBJECTS = [
  "anchor", "basket", "bead", "bell", "book", "bottle",
  "bowl", "box", "brick", "brush", "bucket", "button",
  "candle", "cap", "chest", "clock", "coin", "comb",
  "cup", "drum", "fork", "jar", "key", "kite",
  "lamp", "marble", "mug", "needle", "paddle", "pencil",
  "ribbon", "ring", "spool", "spoon", "thimble", "wheel",
] as const

const FRIENDLY_ID_PATTERN = /^[a-z]+-[a-z]+-[a-z]+$/
const MAX_FRIENDLY_IDS = PLANTS.length * OBJECTS.length * (OBJECTS.length - 1)

export type DiscordFriendlyIdRoute = {
  friendlyId: string
  messageId: string
  channelId: string
}

// These maps make the common generation and resolution paths constant-time.
// SQLite's primary-key/unique constraints remain the cross-restart authority.
const usedIds = new Set<string>()
const routeByFriendlyId = new Map<string, DiscordFriendlyIdRoute>()
const friendlyIdByMessageId = new Map<string, string>()

function remember(route: DiscordFriendlyIdRoute): DiscordFriendlyIdRoute {
  const priorId = friendlyIdByMessageId.get(route.messageId)
  if (priorId && priorId !== route.friendlyId) routeByFriendlyId.delete(priorId)
  usedIds.add(route.friendlyId)
  routeByFriendlyId.set(route.friendlyId, route)
  friendlyIdByMessageId.set(route.messageId, route.friendlyId)
  return route
}

function allocateInMemory(messageId: string, channelId: string): string {
  const cached = friendlyIdByMessageId.get(messageId)
  if (cached) return cached
  for (let attempt = 0; attempt < MAX_FRIENDLY_IDS; attempt += 1) {
    const friendlyId = randomFriendlyId()
    if (usedIds.has(friendlyId)) continue
    remember({ friendlyId, messageId, channelId })
    return friendlyId
  }
  throw new Error("Discord friendly id space exhausted")
}

function randomFriendlyId(): string {
  const plant = PLANTS[randomInt(PLANTS.length)]!
  const firstObjectIndex = randomInt(OBJECTS.length)
  // Pick from n - 1 choices, then skip the first object's index. This makes
  // duplicate object words impossible without a retry.
  const secondChoice = randomInt(OBJECTS.length - 1)
  const secondObjectIndex = secondChoice >= firstObjectIndex ? secondChoice + 1 : secondChoice
  return `${plant}-${OBJECTS[firstObjectIndex]}-${OBJECTS[secondObjectIndex]}`
}

function rowToRoute(row: { friendly_id: string; message_id: string; channel_id: string }): DiscordFriendlyIdRoute {
  return {
    friendlyId: row.friendly_id,
    messageId: row.message_id,
    channelId: row.channel_id,
  }
}

/** Return the durable friendly id for a Discord message, allocating it once. */
export function getOrCreateDiscordFriendlyId(messageId: string, channelId: string): string {
  const safeMessageId = messageId.trim()
  const safeChannelId = channelId.trim()
  if (!safeMessageId || !safeChannelId) throw new Error("message_id and channel_id are required")

  let db: ReturnType<typeof getDb>
  try {
    db = getDb()
  } catch {
    // Pure formatter tests and startup-adjacent callers can run before SQLite
    // initialization. The same process-local uniqueness guarantees still apply.
    return allocateInMemory(safeMessageId, safeChannelId)
  }
  const existing = db.prepare(
    "select friendly_id, message_id, channel_id from discord_message_friendly_ids where message_id = ?",
  ).get(safeMessageId) as { friendly_id: string; message_id: string; channel_id: string } | undefined
  if (existing) return remember(rowToRoute(existing)).friendlyId

  const cachedId = friendlyIdByMessageId.get(safeMessageId)

  const insert = db.prepare(
    `insert or ignore into discord_message_friendly_ids (friendly_id, message_id, channel_id, created_at)
     values (?, ?, ?, ?)`,
  )
  const now = new Date().toISOString()

  if (cachedId) {
    const result = insert.run(cachedId, safeMessageId, safeChannelId, now)
    if (result.changes === 1) return cachedId
    const winner = db.prepare(
      "select friendly_id, message_id, channel_id from discord_message_friendly_ids where message_id = ?",
    ).get(safeMessageId) as { friendly_id: string; message_id: string; channel_id: string } | undefined
    if (winner) return remember(rowToRoute(winner)).friendlyId
    friendlyIdByMessageId.delete(safeMessageId)
    routeByFriendlyId.delete(cachedId)
  }

  for (let attempt = 0; attempt < MAX_FRIENDLY_IDS; attempt += 1) {
    const friendlyId = randomFriendlyId()
    if (usedIds.has(friendlyId)) continue

    const result = insert.run(friendlyId, safeMessageId, safeChannelId, now)
    if (result.changes === 1) {
      remember({ friendlyId, messageId: safeMessageId, channelId: safeChannelId })
      return friendlyId
    }

    // Another allocator may have won either uniqueness constraint.
    const winner = db.prepare(
      "select friendly_id, message_id, channel_id from discord_message_friendly_ids where message_id = ?",
    ).get(safeMessageId) as { friendly_id: string; message_id: string; channel_id: string } | undefined
    if (winner) return remember(rowToRoute(winner)).friendlyId
    usedIds.add(friendlyId)
  }

  throw new Error("Discord friendly id space exhausted")
}

/** Resolve a model-visible friendly id to its exact Discord message and channel. */
export function resolveDiscordFriendlyId(value: unknown): DiscordFriendlyIdRoute | null {
  const friendlyId = String(value ?? "").trim().toLowerCase()
  if (!FRIENDLY_ID_PATTERN.test(friendlyId)) return null

  const cached = routeByFriendlyId.get(friendlyId)
  if (cached) return cached

  let row: { friendly_id: string; message_id: string; channel_id: string } | undefined
  try {
    row = getDb().prepare(
      "select friendly_id, message_id, channel_id from discord_message_friendly_ids where friendly_id = ?",
    ).get(friendlyId) as { friendly_id: string; message_id: string; channel_id: string } | undefined
  } catch {
    return null
  }
  return row ? remember(rowToRoute(row)) : null
}

/** Accept either a raw Discord channel snowflake or a friendly message id. */
export function resolveDiscordChannelId(value: unknown): string {
  const raw = String(value ?? "").trim()
  return resolveDiscordFriendlyId(raw)?.channelId ?? raw
}

export const __friendlyIdTest = {
  plants: PLANTS,
  objects: OBJECTS,
  pattern: FRIENDLY_ID_PATTERN,
}
