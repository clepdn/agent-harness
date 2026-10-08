import type Database from "better-sqlite3"
import { config } from "../config"
import type { RuntimeKind } from "../runner/types"

/** A DM is owner-private once the channel contains an inbound owner message. */
export function isOwnerDmChannel(db: Database.Database, channelId: string): boolean {
  const ownerId = config.discord.owner_id
  const cleanChannelId = String(channelId ?? "").trim()
  if (!ownerId || !cleanChannelId) return false
  return Boolean(db.prepare(
    `select 1
     from discord_messages
     where channel_id = ? and is_dm = 1 and author_id = ? and is_from_bot = 0
     limit 1`,
  ).get(cleanChannelId, ownerId))
}

/** Resolve every DM channel known to contain an inbound owner message. */
export function ownerDmChannelIds(db: Database.Database): string[] {
  const ownerId = config.discord.owner_id
  if (!ownerId) return []
  const rows = db.prepare(
    `select distinct channel_id
     from discord_messages
     where is_dm = 1 and author_id = ? and is_from_bot = 0
     order by channel_id`,
  ).all(ownerId) as Array<{ channel_id: string }>
  return rows.map((row) => row.channel_id)
}

export function assertDiscordChannelAccess(db: Database.Database, channelId: string, kind: RuntimeKind | undefined): void {
  if (kind === "frontend" && isOwnerDmChannel(db, channelId)) {
    throw new Error("owner DM history is unavailable to the frontend agent")
  }
}

export function assertDiscordItemAccess(db: Database.Database, itemId: string, kind: RuntimeKind | undefined): void {
  if (kind !== "frontend") return
  const row = db.prepare(
    `select m.channel_id
     from discord_items i
     join discord_messages m on m.message_id = i.message_id
     where i.item_id = ?`,
  ).get(String(itemId ?? "").trim()) as { channel_id?: string } | undefined
  if (row?.channel_id) assertDiscordChannelAccess(db, row.channel_id, kind)
}

export function filterDiscordRowsForRuntime<T>(db: Database.Database, rows: T[], kind: RuntimeKind | undefined): T[] {
  if (kind !== "frontend") return rows
  return rows.filter((value) => {
    if (!value || typeof value !== "object") return true
    const channelId = (value as Record<string, unknown>).channel_id
    return typeof channelId !== "string" || !isOwnerDmChannel(db, channelId)
  })
}
