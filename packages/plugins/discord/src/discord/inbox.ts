/**
 * Discord inbox state machine — status types, validation, and maintenance routines.
 *
 * @module discord/inbox
 */

import type Database from "better-sqlite3"
import { configuredChannelIdSet } from "./parse"
import type { InboxAction, InboxStatus } from "@nano/runtime-api/contracts/discord"
export type { InboxAction, InboxStatus }

// ── status types ───────────────────────────────────────────────────────


const VALID_STATUS = new Set<InboxStatus>(["pending", "seen", "acted", "ignored"])
export const VALID_ACTION = new Set<InboxAction>(["none", "replied", "messaged", "dismissed", "noted"])

/**
 * Normalizes a status filter input into a validated array of inbox statuses.
 *
 * @param input - Comma-separated string or array.
 * @returns Array of valid statuses, defaulting to `["pending"]`.
 */
export function normalizeStatuses(input?: string[] | string | null): InboxStatus[] {
  const rawValues = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",").map((x) => x.trim())
      : ["pending"]

  const values = rawValues
    .map((x) => x.trim())
    .filter((x): x is InboxStatus => VALID_STATUS.has(x as InboxStatus))

  return values.length > 0 ? values : ["pending"]
}

/**
 * Returns whether a channel id is in the configured set.
 *
 * @param channelId - Channel id to check.
 * @returns `true` when the channel is configured for inbox scanning.
 */
export function isConfiguredDiscordChannel(channelId: string): boolean {
  return configuredChannelIdSet().has(channelId)
}

// ── maintenance ────────────────────────────────────────────────────────

/**
 * Auto-demotes stale pending inbox items to `"seen"` after a timeout.
 *
 * @param staleMinutes - Minutes after which pending items are demoted.
 * @param excludeChannelIds - Channel ids whose pending items are spared.
 * @returns Number of demoted items.
 */
export function autoDemoteStalePendingItems(db: Database.Database, staleMinutes: number, excludeChannelIds?: string[]): number {
  if (staleMinutes <= 0) return 0
  const nowIso = new Date().toISOString()
  const cutoffIso = new Date(Date.now() - staleMinutes * 60_000).toISOString()
  const note = `auto-demoted after ${staleMinutes}m pending timeout`

  const exclude = (excludeChannelIds ?? []).filter(Boolean)
  const excludeClause = exclude.length > 0
    ? `and item_id not in (
         select im.item_id from discord_items im
         join discord_messages dm on dm.message_id = im.message_id
         where dm.channel_id in (${exclude.map(() => "?").join(", ")})
       )`
    : ""

  const result = db.prepare(
    `update discord_items
     set status = 'seen',
         action_taken = case when action_taken = 'none' then 'noted' else action_taken end,
         decision_note = coalesce(decision_note, ?),
         last_decision_at = ?,
         last_seen_at = ?
     where status = 'pending'
       and first_seen_at <= ?
       ${excludeClause}`,
  ).run(note, nowIso, nowIso, cutoffIso, ...exclude)

  return Number(result.changes ?? 0)
}

/**
 * Repairs DM/guild flags on messages and channels based on cross-referenced data.
 *
 * @returns Total number of repaired rows.
 */
export function repairDiscordMessageChannelFlags(db: Database.Database): number {
  const now = new Date().toISOString()

  const dmMessageResult = db.prepare(
    `update discord_messages
     set is_dm = 1,
         channel_type = coalesce(channel_type, 1),
         last_seen_at = ?
     where guild_id is null
       and is_dm = 0`,
  ).run(now)

  const dmChannelResult = db.prepare(
    `update discord_channels
     set is_dm = 1,
         channel_type = case
           when channel_type is null or channel_type = 0 then 1
           else channel_type
         end,
         last_seen_at = ?
     where is_dm = 0
       and exists (
         select 1 from discord_messages m
         where m.channel_id = discord_channels.channel_id
           and m.guild_id is null
           and m.is_dm = 1
       )`,
  ).run(now)

  const guildMessageResult = db.prepare(
    `update discord_messages
     set guild_id = (
           select c.guild_id from discord_channels c
           where c.channel_id = discord_messages.channel_id
             and c.guild_id is not null
         ),
         channel_type = coalesce(
           channel_type,
           (select c.channel_type from discord_channels c where c.channel_id = discord_messages.channel_id)
         ),
         is_dm = 0,
         last_seen_at = ?
     where is_dm = 1
       and exists (
         select 1 from discord_channels c
         where c.channel_id = discord_messages.channel_id
           and c.guild_id is not null
       )`,
  ).run(now)

  return Number(dmMessageResult.changes ?? 0) + Number(dmChannelResult.changes ?? 0) + Number(guildMessageResult.changes ?? 0)
}
