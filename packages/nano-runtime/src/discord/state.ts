/**
 * Discord inbox orchestration — ingest, batch digest, scanning, sending, and listing.
 *
 * All SQL lives in `./db`; this module owns formatting, REST calls,
 * and the high-level workflows that compose db + rest + parse primitives.
 *
 * @module discord/state
 */

import { Routes } from "discord.js"
import { config } from "../config"
import {
  asNumber,
  asString,
  extractFileAttachmentsFromRawJson,
  extractImageAttachmentsFromRawJson,
  parseChannelIds,
  parseChannelRecord,
  parseMessageRecord,
  type DiscordObject,
} from "./parse"
import { inactiveCooldownChannelIds } from "./cooldown"
import {
  autoDemoteStalePendingItems,
  buildReplyTargetContextMap,
  countInterveningMessages,
  countPendingInbox,
  ensureConfiguredChannelsMaterialized,
  extractReferencedMessageId,
  findMessageByContentPrefix,
  findMessageByUsername,
  findPendingDmItemId,
  getChannelRow,
  getDiscordMeta,
  getItemChannelId,
  getItemMessageId,
  getMessageForReference,
  markDiscordMessagesDispatched,
  isConfiguredDiscordChannel,
  messageExists,
  messageExistsById,
  normalizeStatuses,
  queryBatchMessages,
  queryBatchPendingPreview,
  queryChannels,
  queryChannelMessages,
  queryInboxItems,
  repairDiscordMessageChannelFlags,
  setDiscordMeta,
  updateChannelNote,
  updateInboxItem,
  upsertDiscordChannel,
  upsertInboxItem,
  upsertDiscordMessage,
  type DiscordReplyContext,
  type InboxAction,
  type InboxStatus,
  VALID_ACTION,
} from "./db"
import {
  errorMessage,
  getBotUserId,
  makeRestClient,
  withDiscordRestRetry,
} from "./rest"
import { maybeFetchAndCachePronouns } from "./pronouns"
import {
  getOrCreateDiscordFriendlyId,
  resolveDiscordChannelId,
  resolveDiscordFriendlyId,
} from "./friendly-id"
import { readClientFile } from "../client"
import type { RuntimeKind } from "../runner/types"
import type { DiscordMessageTarget } from "../types"
import { assertDiscordChannelAccess, assertDiscordItemAccess, filterDiscordRowsForRuntime, isOwnerDmChannel, ownerDmChannelIds } from "./access"
import { hasDiscordTargetSelector, selectDiscordTarget } from "./targets"

// ── result types ───────────────────────────────────────────────────────

export type DiscordIngestResult = {
  stored: boolean
  isNew: boolean
  messageId?: string
  channelId?: string
  itemId?: string
  bucket?: "dm" | "mention"
  isFromBot?: boolean
  isFromSelf?: boolean
  authorId?: string | null
  isDm?: boolean
  configured?: boolean
  guildId?: string | null
  reason?: string
}

export type DiscordBatchDigest = {
  content: string
  targets: DiscordMessageTarget[]
  messageCount: number
  pendingCount: number
  from: string
  to: string
}

// ── formatting helpers ─────────────────────────────────────────────────

function compactText(value: unknown, maxChars = 180): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim()
  if (!text) return "(no text)"
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars - 1)}...`
}

function fullMessageText(value: unknown): string {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim()
  if (!text) return "(no text)"
  return text.replace(/\n/g, "\n  ")
}

function formatBatchUserBlock(value: unknown, maxChars?: number): string {
  const text = maxChars === undefined ? fullMessageText(value) : compactText(value, maxChars)
  const indented = text.split("\n").map((line) => `  ${line}`).join("\n")
  return `\n  <user>\n${indented}\n  </user>`
}

function formatHumanTimestamp(value: string | null | undefined): string {
  if (!value) return "unknown time"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  })
}

function formatBatchTimestamp(value: string | null | undefined): string {
  if (!value) return "unknown-time"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  })
}

function formatBatchImages(rawJson: string): string {
  const images = extractImageAttachmentsFromRawJson(rawJson)
  if (images.length === 0) return ""
  return ` [images: ${images.map((img) => img.url).join(" ")}]`
}

function formatBatchFiles(rawJson: string): string {
  const files = extractFileAttachmentsFromRawJson(rawJson)
  if (files.length === 0) return ""
  return ` [files: ${files.map((file) => `${file.filename ?? "attachment"}=${file.url}`).join(" ")}]`
}

function formatBatchAttachments(rawJson: string): string {
  return `${formatBatchImages(rawJson)}${formatBatchFiles(rawJson)}`
}

function formatReplyContext(reply: DiscordReplyContext | undefined): string {
  if (!reply) return ""
  const author = reply.author_username ? `@${reply.author_username}` : "unknown"
  return ` [reply_to ${author}: ${JSON.stringify(reply.content)}]`
}

function channelLabel(row: { is_dm: number; guild_name: string | null; guild_id: string | null; channel_name: string | null; channel_id: string }): string {
  if (row.is_dm === 1) return "dm"
  const guild = row.guild_name ?? "Discord"
  const channel = row.channel_name ?? "channel"
  return `channel/${guild}/#${channel}`
}

// ── inbox detection ────────────────────────────────────────────────────

function detectInboxBucket(record: ReturnType<typeof parseMessageRecord>): "dm" | "mention" | null {
  if (!record) return null
  if (record.isFromSelf) return null
  if (record.isDm) return "dm"
  if (record.mentionsBot && isConfiguredDiscordChannel(record.channelId)) return "mention"
  return null
}

// ── ingest ─────────────────────────────────────────────────────────────

/**
 * Parses and persists a Discord event into the local message/channel/inbox tables.
 *
 * @param payload - Raw Discord gateway or webhook payload.
 * @param options - Optional bot user id override.
 * @returns Ingest result describing what was stored and classified.
 */
export function ingestDiscordEvent(payload: unknown, options?: { botUserId?: string }): DiscordIngestResult {
  const record = parseMessageRecord(payload, options?.botUserId)
  if (!record) {
    return { stored: false, isNew: false, reason: "payload is missing message/channel identity" }
  }

  if (record.isDm && !record.isFromSelf) {
    const allowedIds = config.discord.dm_whitelist
    if (allowedIds.length > 0 && (!record.authorId || !allowedIds.includes(record.authorId))) {
      return {
        stored: false,
        isNew: false,
        authorId: record.authorId,
        isDm: record.isDm,
        guildId: record.guildId,
        reason: "ignored DM: sender is not in [discord].dm_whitelist",
      }
    }
  }

  const isNew = !messageExists(record.messageId)
  const configured = !record.isDm && isConfiguredDiscordChannel(record.channelId)

  const channelRecord = parseChannelRecord(payload, {
    channelId: record.channelId,
    guildId: record.guildId,
    channelType: record.channelType,
    isDm: record.isDm,
  })
  if (channelRecord) upsertDiscordChannel(channelRecord)

  upsertDiscordMessage(record)

  if (record.authorId) {
    void maybeFetchAndCachePronouns(record.authorId)
  }

  const bucket = detectInboxBucket(record)
  if (bucket) {
    upsertInboxItem(record.messageId, bucket)
    return {
      stored: true,
      isNew,
      messageId: record.messageId,
      channelId: record.channelId,
      itemId: record.messageId,
      bucket,
      isFromBot: record.isFromBot,
      isFromSelf: record.isFromSelf,
      authorId: record.authorId,
      isDm: record.isDm,
      configured,
      guildId: record.guildId,
    }
  }

  return {
    stored: true,
    isNew,
    messageId: record.messageId,
    channelId: record.channelId,
    isFromBot: record.isFromBot,
    isFromSelf: record.isFromSelf,
    authorId: record.authorId,
    isDm: record.isDm,
    configured,
    guildId: record.guildId,
    ...(!record.isDm && record.mentionsBot && !configured
      ? { reason: "ignored mention from unconfigured channel" }
      : {}),
  }
}

// ── inbox listing ──────────────────────────────────────────────────────

/**
 * Lists Discord inbox items from local state.
 *
 * @param limit - Maximum rows (default 20, max 200).
 * @param statuses - Status filter string or array.
 * @returns Raw inbox rows.
 */
export function listDiscordInbox(limit = 20, statuses?: string[] | string, kind: RuntimeKind = "main"): unknown[] {
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit) || 20))
  const statusList = normalizeStatuses(statuses)
  const rows = filterDiscordRowsForRuntime(queryInboxItems(statusList, safeLimit), kind) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    ...row,
    id: getOrCreateDiscordFriendlyId(String(row.message_id), String(row.channel_id)),
  }))
}

// ── backread ───────────────────────────────────────────────────────────

/**
 * Reads stored Discord message history for a channel, newest first.
 *
 * @param channelId - Discord channel id.
 * @param limit - Maximum rows (default 40, max 200).
 * @param beforeMessageId - Optional cursor for pagination.
 * @returns Message rows with resolved reply context.
 */
export function listDiscordBackread(channelId: string, limit = 40, beforeMessageId?: string, kind: RuntimeKind = "main"): unknown[] {
  const safeChannelId = resolveDiscordChannelId(channelId)
  if (!safeChannelId) throw new Error("channel_id is required")
  assertDiscordChannelAccess(safeChannelId, kind)

  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit) || 40))
  const before = String(beforeMessageId ?? "").trim()
  const rows = queryChannelMessages(safeChannelId, before, safeLimit)

  const replyByMessageId = buildReplyTargetContextMap(rows)
  return rows.map(({ raw_json: _rawJson, ...row }) => ({
    ...row,
    id: getOrCreateDiscordFriendlyId(row.message_id, row.channel_id),
    source_item_id: row.message_id,
    created_at: formatHumanTimestamp(row.created_at),
    ...(replyByMessageId.has(row.message_id) ? { reply_to: replyByMessageId.get(row.message_id) } : {}),
  }))
}

// ── mark ───────────────────────────────────────────────────────────────

/**
 * Updates decision state for a Discord inbox item.
 *
 * @param itemId - Inbox item id.
 * @param status - New status.
 * @param note - Optional decision note.
 * @param action - Action taken.
 */
export function markDiscordItem(itemId: string, status: InboxStatus, note = "", action: InboxAction = "none", kind: RuntimeKind = "main"): void {
  const safeItemId = String(itemId ?? "").trim()
  if (!safeItemId) throw new Error("item_id is required")
  assertDiscordItemAccess(safeItemId, kind)
  if (!["pending", "seen", "acted", "ignored"].includes(status)) throw new Error(`invalid status: ${status}`)
  if (!VALID_ACTION.has(action)) throw new Error(`invalid action: ${action}`)
  updateInboxItem(safeItemId, status, action, note || null)
}

// ── channels listing / notes ───────────────────────────────────────────

/**
 * Lists configured Discord channels and DM channels with stored interactions.
 *
 * @returns Channel rows.
 */
export function listDiscordChannels(kind: RuntimeKind = "main"): unknown[] {
  ensureConfiguredChannelsMaterialized()
  const configuredIds = parseChannelIds()
  return filterDiscordRowsForRuntime(queryChannels(configuredIds), kind)
}

/**
 * Sets or clears a persistent note for a Discord channel.
 *
 * @param channelId - Channel id to annotate.
 * @param note - Note text (empty string clears it).
 * @returns Updated channel row.
 */
export function setDiscordChannelNote(channelId: string, note: string, kind: RuntimeKind = "main"): Record<string, unknown> {
  const safeChannelId = resolveDiscordChannelId(channelId)
  if (!safeChannelId) throw new Error("channel_id is required")
  assertDiscordChannelAccess(safeChannelId, kind)

  ensureConfiguredChannelsMaterialized([safeChannelId])
  const trimmed = note.trim()
  updateChannelNote(safeChannelId, trimmed.length > 0 ? trimmed : null)

  const row = getChannelRow(safeChannelId)
  return {
    ok: true,
    cleared: trimmed.length === 0,
    ...(row ?? { channel_id: safeChannelId }),
  }
}

// ── batch digest ───────────────────────────────────────────────────────

const DEFAULT_SCAN_LIMIT = 50

/**
 * Builds a formatted batch digest of recent Discord activity for the runner.
 *
 * @param params - Optional batch parameters.
 * @returns Formatted digest, or `null` when no new messages exist.
 */
export function buildDiscordBatchDigest(params?: {
  maxMessages?: number
  pendingPreviewLimit?: number
  intervalMs?: number
  runtimeKind?: RuntimeKind
}): DiscordBatchDigest | null {
  const now = new Date()
  const nowIso = now.toISOString()
  const defaultIntervalMs = Math.max(1_000, config.discord.batch_interval_ms)
  const intervalMs = Math.max(1_000, Math.trunc(params?.intervalMs ?? defaultIntervalMs))
  const maxMessages = Math.max(1, Math.min(200, Math.trunc(params?.maxMessages ?? 40) || 40))
  const previewLimit = Math.max(1, Math.min(50, Math.trunc(params?.pendingPreviewLimit ?? 6) || 6))
  const channelPoll = config.discord.channel_poll
  const batchOnlyConfigured = config.discord.batch_only_configured
  const autoSeenMinutes = Math.max(0, config.discord.pending_auto_seen_minutes)
  const configuredIds = parseChannelIds()
  // Cooldown channels outside their active window: spare their pending items
  // from both the stale-demote and this digest, so they resurface when active.
  const inactiveChannelIds = inactiveCooldownChannelIds()
  repairDiscordMessageChannelFlags()
  const privateChannelIds = params?.runtimeKind === "frontend" ? ownerDmChannelIds() : []
  const activeConfiguredIds =
    inactiveChannelIds.length > 0 ? configuredIds.filter((id) => !inactiveChannelIds.includes(id)) : configuredIds
  const polledChannelIds = channelPoll ? activeConfiguredIds : []
  const configuredPlaceholders = polledChannelIds.map(() => "?").join(", ")
  let configuredScopeClause = "and m.is_dm = 1"
  if (channelPoll) {
    if (!batchOnlyConfigured) configuredScopeClause = ""
    else if (polledChannelIds.length > 0) {
      configuredScopeClause = `and (m.is_dm = 1 or m.channel_id in (${configuredPlaceholders}))`
    }
  }
  const privateScopeClause = privateChannelIds.length > 0
    ? `and m.channel_id not in (${privateChannelIds.map(() => "?").join(", ")})`
    : ""
  const channelScopeClause = `${configuredScopeClause} ${privateScopeClause}`
  const botUserId = config.discord.bot_user_id

  autoDemoteStalePendingItems(autoSeenMinutes, [...new Set([...inactiveChannelIds, ...privateChannelIds])])

  const from =
    getDiscordMeta("discord_batch_last_dispatched_at") ??
    new Date(now.getTime() - intervalMs).toISOString()

  const queryOpts = {
    botUserId,
    from,
    configuredIds: [...polledChannelIds, ...privateChannelIds],
    channelScopeClause,
  }

  const messageRows = queryBatchMessages({ ...queryOpts, limit: maxMessages + 1 })

  if (messageRows.length === 0) return null

  const truncated = messageRows.length > maxMessages
  const recentMessages = truncated ? messageRows.slice(0, maxMessages) : messageRows

  const pendingCount = countPendingInbox(queryOpts)

  const pendingPreview = queryBatchPendingPreview({ ...queryOpts, limit: previewLimit })

  // Cooldown channels outside their active window are dropped from this digest
  // and left as `pending` so they resurface once the window opens. The inactive
  // set was computed above (before the stale-demote) and reused here.
  const activeRecentMessages = inactiveChannelIds.length
    ? recentMessages.filter((row) => !inactiveChannelIds.includes(row.channel_id))
    : recentMessages
  const activePendingPreview = inactiveChannelIds.length
    ? pendingPreview.filter((row) => !inactiveChannelIds.includes(row.channel_id))
    : pendingPreview
  const visibleRecentMessages = filterDiscordRowsForRuntime(activeRecentMessages, params?.runtimeKind)
  const visiblePendingPreview = filterDiscordRowsForRuntime(activePendingPreview, params?.runtimeKind)

  // If cooldown filtering removed everything, skip this batch (leave items
  // pending) rather than waking the agent with an empty digest.
  if (visibleRecentMessages.length === 0 && visiblePendingPreview.length === 0) return null

  const replyContextByMessageId = buildReplyTargetContextMap([...visibleRecentMessages, ...visiblePendingPreview])
  const targets: DiscordMessageTarget[] = []
  const targetByMessageId = new Map<string, DiscordMessageTarget>()
  const targetLabel = (row: {
    message_id: string
    channel_id: string
    item_id?: string | null
    content: string
    created_at: string
  }): string => {
    let target = targetByMessageId.get(row.message_id)
    if (!target) {
      const friendlyId = getOrCreateDiscordFriendlyId(row.message_id, row.channel_id)
      target = {
        position: targets.length + 1,
        friendlyId,
        channelId: row.channel_id,
        messageId: row.message_id,
        ...(row.item_id ? { itemId: row.item_id } : {}),
        content: fullMessageText(row.content),
        createdAt: row.created_at,
      }
      targetByMessageId.set(row.message_id, target)
      targets.push(target)
    } else if (!target.itemId && row.item_id) {
      target.itemId = row.item_id
    }
    return `target: ${target.position} id: ${target.friendlyId}`
  }
  const hasImages = [...visibleRecentMessages, ...visiblePendingPreview].some(
    (row) => extractImageAttachmentsFromRawJson(row.raw_json).length > 0,
  )
  const hasFiles = [...visibleRecentMessages, ...visiblePendingPreview].some(
    (row) => extractFileAttachmentsFromRawJson(row.raw_json).length > 0,
  )

  const lines: string[] = [
    `[discord batch] ${formatBatchTimestamp(from)} -> ${formatBatchTimestamp(nowIso)}`,
    "channel messages are context, not direct requests. replying is optional; use judgment.",
    ...(hasImages
      ? params?.runtimeKind === "frontend"
        ? ["image attachments appear as [images: <discord cdn urls>]; this runtime has no download or image-inspection tool, so ask the main agent via agent_send if inspection matters."]
        : config.model.vision
        ? ["image attachments appear as [images: <discord cdn urls>]; download with shell, then inspect with image_tool if useful."]
        : ["image attachments appear as [images: <discord cdn urls>]; download with shell if needed."]
      : []),
    ...(hasFiles
      ? params?.runtimeKind === "frontend"
        ? ["file attachments appear as [files: <filename>=<discord cdn url>]; this runtime cannot download them, so ask the main agent via agent_send if the file matters."]
        : ["file attachments appear as [files: <filename>=<discord cdn url>]; download with shell if useful."]
      : []),
    "",
    "recent messages:",
  ]

  for (const row of visibleRecentMessages) {
    const label = channelLabel(row)
    const pronounsSuffix = row.pronouns ? ` (${row.pronouns})` : ""
    const author = row.author_username ? `@${row.author_username}${pronounsSuffix}` : "@unknown"
    const ts = formatBatchTimestamp(row.created_at)
    const replyTo = replyContextByMessageId.get(row.message_id)
    lines.push(`- ${targetLabel(row)} [${label}] [${ts}] ${author}${formatReplyContext(replyTo)}:${formatBatchUserBlock(row.content)}${formatBatchAttachments(row.raw_json)}`)
  }

  if (truncated) {
    lines.push(`- ...truncated at ${maxMessages} messages`)
  }

  lines.push("")
  lines.push("pending preview:")
  if (visiblePendingPreview.length === 0) {
    lines.push("- (none)")
  } else {
    for (const row of visiblePendingPreview) {
      const label = channelLabel(row)
      const pronounsSuffix = row.pronouns ? ` (${row.pronouns})` : ""
      const author = row.author_username ? `@${row.author_username}${pronounsSuffix}` : "@unknown"
      const ts = formatBatchTimestamp(row.created_at)
      const replyTo = replyContextByMessageId.get(row.message_id)
      lines.push(`- ${targetLabel(row)} bucket=${row.bucket} [${label}] [${ts}] ${author}${formatReplyContext(replyTo)}:${formatBatchUserBlock(row.content, 120)}${formatBatchAttachments(row.raw_json)}`)
    }
  }

  lines.push("")
  lines.push("you can reply if useful via discord_send; omit target for the latest message, or use its shown target number or a prefix of its text.")

  // Only mark items we actually surfaced as seen. Inactive cooldown-channel
  // items are left `pending` so they reappear once their window opens.
  for (const row of visibleRecentMessages) {
    if (row.item_id) {
      updateInboxItem(row.item_id, "seen", "noted", "auto-seen after inclusion in Discord batch context")
    }
  }
  for (const row of visiblePendingPreview) {
    updateInboxItem(row.item_id, "seen", "noted", "auto-seen after inclusion in Discord batch context")
  }
  markDiscordMessagesDispatched([
    ...visibleRecentMessages.map((row) => row.message_id),
    ...visiblePendingPreview.map((row) => row.message_id),
  ])

  const lastVisibleRecent = visibleRecentMessages.at(-1)
  setDiscordMeta("discord_batch_last_dispatched_at", truncated && lastVisibleRecent ? lastVisibleRecent.first_seen_at : nowIso)

  return {
    content: lines.join("\n"),
    targets,
    messageCount: visibleRecentMessages.length,
    pendingCount,
    from,
    to: nowIso,
  }
}

// ── send ───────────────────────────────────────────────────────────────

type ReplyMode = "auto" | "plain" | "explicit"

function resolveReferenceMessage(channelId: string, sourceItemId?: string, referenceMessage?: string): string | null {
  const ref = referenceMessage?.trim()
  if (ref) {
    const friendly = resolveDiscordFriendlyId(ref)
    if (friendly) return friendly.channelId === channelId ? friendly.messageId : null

    if (/^\d+$/.test(ref) && messageExistsById(ref)) return ref

    const byContent = findMessageByContentPrefix(channelId, ref)
    if (byContent) return byContent

    const byUsername = findMessageByUsername(channelId, `%${ref}%`)
    if (byUsername) return byUsername

    return null
  }

  return resolveSourceMessageId(sourceItemId)
}

function resolveSourceMessageId(sourceItemId?: string): string | null {
  const safeSourceItemId = sourceItemId?.trim()
  if (!safeSourceItemId) return null
  return getItemMessageId(safeSourceItemId) ?? (messageExistsById(safeSourceItemId) ? safeSourceItemId : null)
}

function resolveSourceChannelId(sourceItemId?: string): string | null {
  const sourceMessageId = resolveSourceMessageId(sourceItemId)
  if (!sourceMessageId) return null
  return getMessageForReference(sourceMessageId)?.channel_id?.trim() || null
}

const AUTO_REPLY_STALE_MINUTES = 10
const AUTO_REPLY_GROUP_SCAN_LIMIT = 40

function responseGroupAlreadyReferencesSource(
  recent: ReturnType<typeof queryChannelMessages>,
  sourceMessageId: string,
): boolean {
  for (const row of recent) {
    if (row.message_id === sourceMessageId) return false
    if (row.is_from_bot !== 1) return false
    if (extractReferencedMessageId(row.raw_json) === sourceMessageId) return true
  }
  return false
}

function shouldKeepAutoReplyPlain(channelId: string, sourceMessageId: string): boolean {
  const recent = queryChannelMessages(channelId, "", AUTO_REPLY_GROUP_SCAN_LIMIT)
  if (recent[0]?.message_id === sourceMessageId) return true
  return responseGroupAlreadyReferencesSource(recent, sourceMessageId)
}

function shouldUseReplyReference(channelId: string, sourceMessageId: string): boolean {
  const source = getMessageForReference(sourceMessageId)

  if (!source?.message_id || !source.channel_id) return false
  if (source.channel_id !== channelId) return false

  // The next message after the source should read as normal conversation. A
  // single model response may also be delivered as several consecutive
  // messages; once that group references the source, keep the rest plain until
  // another person speaks.
  if (shouldKeepAutoReplyPlain(channelId, sourceMessageId)) return false

  const createdMs = Date.parse(source.created_at ?? "")
  if (Number.isFinite(createdMs)) {
    const staleMs = AUTO_REPLY_STALE_MINUTES * 60_000
    if (Date.now() - createdMs >= staleMs) return true
  }

  const intervening = countInterveningMessages(channelId, sourceMessageId, source.author_id ?? "")
  return intervening > 0
}

function inferPendingDmItemId(channelId: string): string | null {
  return findPendingDmItemId(channelId)
}

function normalizeReplyMode(value: unknown): ReplyMode {
  if (value === "plain" || value === "explicit" || value === "auto") return value
  return "auto"
}

type DeliveryTargetParams = {
  channelId?: string
  sourceItemId?: string
  referenceMessage?: string
  target?: unknown
  turnTargets?: readonly DiscordMessageTarget[]
  replyMode?: string
}

export async function resolveDiscordDeliveryTarget(params: DeliveryTargetParams): Promise<{
  channelId: string
  replyMode: ReplyMode
  sourceItemId: string | null
  sourceMessageId: string | null
  referenceMessageId: string | null
  inferredSourceItemId: string | null
}> {
  const turnTargets = params.turnTargets ?? []
  const selectorSupplied = hasDiscordTargetSelector(params.target)
  const requestedChannelId = resolveDiscordChannelId(params.channelId)
  const referenceRoute = selectorSupplied ? null : resolveDiscordFriendlyId(params.referenceMessage)
  const selected = selectorSupplied || (!requestedChannelId && !referenceRoute)
    ? selectDiscordTarget(turnTargets, params.target)
    : null
  const latest = requestedChannelId || referenceRoute ? null : selectDiscordTarget(turnTargets)

  if (selectorSupplied && !selected && typeof params.target === "number") {
    throw new Error(`target ${String(params.target)} is not present in the recent Discord target registry`)
  }

  let channelId = requestedChannelId
  const contextualChannelId = selected?.channelId ?? referenceRoute?.channelId ?? latest?.channelId
  if (channelId && selected && channelId !== selected.channelId) {
    throw new Error("target belongs to a different Discord channel")
  }
  if (!channelId) channelId = contextualChannelId ?? ""
  if (!channelId && params.sourceItemId?.trim()) {
    channelId = getItemChannelId(params.sourceItemId.trim()) ?? resolveSourceChannelId(params.sourceItemId) ?? ""
  }
  if (!channelId) throw new Error("no active Discord target; provide channel_id for a proactive message")

  const explicitSourceItemId = selected?.itemId ?? selected?.messageId ?? params.sourceItemId?.trim() ?? null
  const inferredSourceItemId = explicitSourceItemId ? null : inferPendingDmItemId(channelId)
  let resolvedSourceItemId = explicitSourceItemId ?? inferredSourceItemId
  const referenceSelector = selectorSupplied
    ? selected?.messageId ?? String(params.target).trim()
    : params.referenceMessage
  const requestedReferenceId = selectorSupplied && selected
    ? selected.messageId
    : resolveReferenceMessage(
        channelId,
        resolvedSourceItemId ?? undefined,
        referenceSelector,
      )
  if (selectorSupplied && !requestedReferenceId) {
    throw new Error(`no message starts with target prefix ${JSON.stringify(String(params.target).trim())}`)
  }
  if (selectorSupplied && !resolvedSourceItemId && requestedReferenceId) resolvedSourceItemId = requestedReferenceId

  const replyMode = normalizeReplyMode(params.replyMode)
  const referenceMessageId = requestedReferenceId
    ? replyMode === "plain"
      ? null
      : shouldUseReplyReference(channelId, requestedReferenceId)
        ? requestedReferenceId
        : null
    : null

  return {
    channelId,
    replyMode,
    sourceItemId: resolvedSourceItemId,
    sourceMessageId: resolveSourceMessageId(resolvedSourceItemId ?? undefined),
    referenceMessageId,
    inferredSourceItemId,
  }
}

/**
 * Sends a Discord message with optional reply reference resolution.
 *
 * @param params - Send parameters including channel, content, and reply options.
 * @returns Send result with message id and resolved reference information.
 */
export async function sendDiscordMessage(params: {
  channelId?: string
  content: string
  target?: unknown
  turnTargets?: readonly DiscordMessageTarget[]
  sourceItemId?: string
  replyMode?: string
  referenceMessage?: string
  runtimeKind?: RuntimeKind
}): Promise<Record<string, unknown>> {
  const delivery = await resolveDiscordDeliveryTarget(params)
  const { channelId, replyMode, sourceItemId: resolvedSourceItemId, sourceMessageId: resolvedSourceMessageId,
    referenceMessageId, inferredSourceItemId } = delivery
  assertDiscordChannelAccess(channelId, params.runtimeKind)

  const content = String(params.content ?? "").trim()
  if (!content) throw new Error("content is required")

  const rest = makeRestClient()
  const botUserId = await getBotUserId(rest)

  const message = (await withDiscordRestRetry(`send message ${channelId}`, () =>
    rest.post(Routes.channelMessages(channelId), {
      body: {
        content,
        ...(referenceMessageId
          ? {
              message_reference: {
                message_id: referenceMessageId,
                channel_id: channelId,
                fail_if_not_exists: false,
              },
              allowed_mentions: { replied_user: false },
            }
          : {}),
      },
    }),
  )) as DiscordObject

  const ingest = ingestDiscordEvent(
    {
      message,
      channel: {
        id: channelId,
        type: message.guild_id == null ? 1 : null,
        guild_id: message.guild_id,
      },
      is_dm: message.guild_id == null,
      author_is_bot: true,
    },
    { botUserId },
  )

  if (resolvedSourceItemId && getItemMessageId(resolvedSourceItemId)) {
    const wasInferred = inferredSourceItemId !== null
    markDiscordItem(
      resolvedSourceItemId,
      "acted",
      `responded via discord_send (${replyMode}${referenceMessageId ? ", explicit" : ", plain"}${wasInferred ? ", inferred_dm_item" : ""})`,
      referenceMessageId ? "replied" : "messaged",
    )
  }

  return {
    ok: true,
    sent_message_id: asString(message.id),
    channel_id: channelId,
    reply_mode: replyMode,
    used_reference_message_id: referenceMessageId,
    resolved_source_item_id: resolvedSourceItemId,
    resolved_source_message_id: resolvedSourceMessageId,
    inferred_source_item_id: inferredSourceItemId,
    stored: ingest.stored,
  }
}

// ── file upload ────────────────────────────────────────────────────────

const DISCORD_MAX_FILE_BYTES = 25 * 1024 * 1024 // 25 MB

/**
 * Uploads a file to a Discord channel, optionally with a text caption.
 *
 * @param params - Upload parameters.
 * @returns Upload result with message id and attachment info.
 */
export async function uploadDiscordFile(params: {
  channelId?: string
  filePath: string
  content?: string
  target?: unknown
  turnTargets?: readonly DiscordMessageTarget[]
  sourceItemId?: string
  replyMode?: string
  referenceMessage?: string
  runtimeKind?: RuntimeKind
}): Promise<Record<string, unknown>> {
  const delivery = await resolveDiscordDeliveryTarget(params)
  const { channelId, replyMode, sourceItemId: resolvedSourceItemId, referenceMessageId,
    inferredSourceItemId } = delivery
  assertDiscordChannelAccess(channelId, params.runtimeKind)

  const filePath = String(params.filePath ?? "").trim()
  if (!filePath) throw new Error("file_path is required")

  // The path names the attached client's filesystem, not ours.
  let fileBuf: Buffer
  let fileName: string
  let fileSize: number

  try {
    const artifact = await readClientFile(filePath, DISCORD_MAX_FILE_BYTES)
    fileBuf = artifact.data
    fileName = artifact.name
    fileSize = artifact.data.length
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.startsWith("file too large") || msg.startsWith("not a regular file")) throw new Error(msg)
    throw new Error(`cannot read upload file: ${msg}`)
  }

  const content = String(params.content ?? "").trim()

  const rest = makeRestClient()
  const botUserId = await getBotUserId(rest)

  const body: Record<string, unknown> = {}
  if (content) body.content = content
  if (referenceMessageId) {
    body.message_reference = {
      message_id: referenceMessageId,
      channel_id: channelId,
      fail_if_not_exists: false,
    }
    body.allowed_mentions = { replied_user: false }
  }

  const message = (await withDiscordRestRetry(`upload file ${channelId}`, () =>
    rest.post(Routes.channelMessages(channelId), {
      body,
      files: [{ name: fileName, data: fileBuf }],
    }),
  )) as DiscordObject

  const ingest = ingestDiscordEvent(
    {
      message,
      channel: {
        id: channelId,
        type: message.guild_id == null ? 1 : null,
        guild_id: message.guild_id,
      },
      is_dm: message.guild_id == null,
      author_is_bot: true,
    },
    { botUserId },
  )

  // Extract attachment URLs from the returned message object
  const attachments: unknown[] = Array.isArray((message as Record<string, unknown>).attachments)
    ? ((message as Record<string, unknown>).attachments as unknown[])
    : []
  const attachmentUrls = attachments
    .map((a) => {
      const obj = a as Record<string, unknown> | undefined
      return typeof obj?.url === "string" ? obj.url : null
    })
    .filter(Boolean)

  if (resolvedSourceItemId) {
    const wasInferred = inferredSourceItemId !== null
    markDiscordItem(
      resolvedSourceItemId,
      "acted",
      `uploaded file${wasInferred ? ", inferred_dm_item" : ""}`,
      referenceMessageId ? "replied" : "messaged",
    )
  }

  return {
    ok: true,
    sent_message_id: asString(message.id),
    channel_id: channelId,
    file_name: fileName,
    file_size: fileSize,
    content,
    attachment_urls: attachmentUrls,
    reply_mode: replyMode,
    used_reference_message_id: referenceMessageId,
    resolved_source_item_id: resolvedSourceItemId,
    stored: ingest.stored,
  }
}

// ── scan ───────────────────────────────────────────────────────────────

/**
 * Scans configured Discord channels via REST API and ingests messages.
 *
 * @param params - Scan parameters.
 * @returns Summary of scanned channels and fetched/stored messages.
 */
export async function scanDiscordChannels(params?: {
  limit?: number
  channelIds?: string[] | string
  beforeMessageId?: string
  runtimeKind?: RuntimeKind
}): Promise<Record<string, unknown>> {
  const rest = makeRestClient()
  const botUserId = await getBotUserId(rest)

  const requestedChannelIds = parseChannelIds(params?.channelIds).map(resolveDiscordChannelId)
  const channelIds = params?.runtimeKind === "frontend"
    ? requestedChannelIds.filter((channelId) => !isOwnerDmChannel(channelId))
    : requestedChannelIds
  ensureConfiguredChannelsMaterialized(channelIds)
  if (channelIds.length === 0) {
    return {
      scanned_channels: 0,
      fetched_messages: 0,
      stored_messages: 0,
      inbox_items: 0,
      note: "no channels configured; set [discord].scan_channel_ids or pass channel_ids",
    }
  }

  const limit = Math.max(1, Math.min(100, Math.trunc(params?.limit ?? DEFAULT_SCAN_LIMIT) || DEFAULT_SCAN_LIMIT))
  const before = asString(params?.beforeMessageId)

  let fetchedMessages = 0
  let storedMessages = 0
  let inboxItems = 0
  const guildNameCache = new Map<string, string | null>()

  for (const channelId of channelIds) {
    const channel = (await withDiscordRestRetry(`get channel ${channelId}`, () =>
      rest.get(Routes.channel(channelId)),
    )) as DiscordObject
    const channelType = asNumber(channel.type)
    const guildId = asString(channel.guild_id)
    let guildName: string | null = null
    if (guildId) {
      if (guildNameCache.has(guildId)) {
        guildName = guildNameCache.get(guildId) ?? null
      } else {
        try {
          const guild = (await withDiscordRestRetry(`get guild ${guildId}`, () =>
            rest.get(Routes.guild(guildId)),
          )) as DiscordObject
          guildName = asString(guild.name)
          guildNameCache.set(guildId, guildName)
        } catch (err) {
          console.warn(`[discord scan] failed to resolve guild ${guildId}: ${errorMessage(err)}`)
          guildNameCache.set(guildId, null)
        }
      }
    }

    upsertDiscordChannel({
      channelId,
      guildId,
      channelType,
      channelName: asString(channel.name),
      guildName,
      topic: asString(channel.topic),
      isDm: channelType === 1 || channelType === 3,
      configured: true,
      rawJson: JSON.stringify(channel),
    })
    const query = new URLSearchParams({ limit: String(limit) })
    if (before) query.set("before", before)

    const messages = (await withDiscordRestRetry(`get channel messages ${channelId}`, () =>
      rest.get(Routes.channelMessages(channelId), {
        query,
      }),
    )) as unknown[]

    fetchedMessages += messages.length

    for (const message of messages) {
      const result = ingestDiscordEvent(
        {
          message,
          channel: {
            id: channelId,
            type: channelType,
            guild_id: guildId,
          },
        },
        { botUserId },
      )

      if (result.stored) {
        storedMessages += 1
        if (result.itemId) inboxItems += 1
      }
    }
  }

  return {
    scanned_channels: channelIds.length,
    fetched_messages: fetchedMessages,
    stored_messages: storedMessages,
    inbox_items: inboxItems,
  }
}
