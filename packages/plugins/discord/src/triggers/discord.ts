import type { DiscordTriggerOptions } from "@nano/runtime-api/contracts/discord"
import type { UserMessage } from "@nano/runtime-api/types"
import {
  asObject,
  asString,
  extractFileAttachments,
  extractImageAttachments,
  renderDiscordUserMentions,
} from "../discord/parse"
import { discordEmojiMarkup } from "../discord/context-emojis"

export type { DiscordTriggerOptions }

const defaultOptions: DiscordTriggerOptions = { modelVision: false }

function asIsoTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string" && typeof value !== "number") return fallback
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString()
}

function formatDiscordTimestamp(value: string): string {
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

const asRecord = asObject

function referencedMessageId(message: Record<string, unknown>, body: Record<string, unknown>): string | null {
  const reference =
    asRecord(message.message_reference) ??
    asRecord(body.message_reference) ??
    asRecord(message.reference) ??
    asRecord(body.reference)
  return asString(reference?.message_id) ?? asString(reference?.messageId) ?? asString(reference?.id)
}

function embeddedReferencedMessage(
  message: Record<string, unknown>,
  body: Record<string, unknown>,
): { message_id: string; author_username: string | null; content: string } | null {
  const referenced = asRecord(message.referenced_message) ?? asRecord(body.referenced_message)
  if (!referenced) return null

  const messageId = asString(referenced.id)
  if (!messageId) return null

  const author = asRecord(referenced.author)
  const member = asRecord(referenced.member)
  return {
    message_id: messageId,
    author_username:
      asString(member?.display_name) ??
      asString(member?.displayName) ??
      asString(member?.nickname) ??
      asString(member?.nick) ??
      asString(author?.global_name) ??
      asString(author?.globalName) ??
      asString(author?.username),
    content: String(referenced.content ?? ""),
  }
}

function replyContextLine(message: Record<string, unknown>, body: Record<string, unknown>, options: DiscordTriggerOptions): string | null {
  const refId = referencedMessageId(message, body)
  if (!refId || !options.db) return null
  const stored = options.db
    .prepare(
      `select message_id, author_username, content
       from discord_messages
       where message_id = ?`,
    )
    .get(refId) as { message_id: string; author_username: string | null; content: string } | undefined
  const reply = stored ?? embeddedReferencedMessage(message, body) ?? {
    message_id: refId,
    author_username: null,
    content: "",
  }
  const author = reply.author_username ? `@${reply.author_username}` : "unknown"
  return `reply_to: ${author}: ${JSON.stringify(reply.content)}`
}

function formatImageBlock(images: ReturnType<typeof extractImageAttachments>, modelVision: boolean): string {
  if (images.length === 0) return ""
  const lines = images.map((img) => {
    const meta = [img.filename, img.contentType].filter(Boolean).join(", ")
    return `- ${img.url}${meta ? ` (${meta})` : ""}`
  })
  return `\n\nimages (discord cdn links — download with shell${modelVision ? ", then inspect with image_tool if useful" : ""}):\n${lines.join("\n")}`
}
function formatFileBlock(files: ReturnType<typeof extractFileAttachments>): string {
  if (files.length === 0) return ""
  const lines = files.map((file) => {
    const meta = [file.filename, file.contentType, file.size == null ? null : `${file.size} bytes`]
      .filter(Boolean)
      .join(", ")
    return `- ${file.url}${meta ? ` (${meta})` : ""}`
  })
  return `\n\nfiles (discord cdn download links — download with shell if useful):\n${lines.join("\n")}`
}

export function fromDiscord(body: unknown, suppliedOptions: DiscordTriggerOptions = defaultOptions): UserMessage {
  const options = suppliedOptions
  const b = body as Record<string, unknown>
  const message = (typeof b.message === "object" && b.message
    ? (b.message as Record<string, unknown>)
    : b) as Record<string, unknown>
  const author =
    typeof message.author === "object" && message.author
      ? (message.author as Record<string, unknown>)
      : null
  const channel =
    typeof b.channel === "object" && b.channel
      ? (b.channel as Record<string, unknown>)
      : null

  const channelType = Number(message.channel_type ?? b.channel_type ?? channel?.type ?? NaN)
  const guildId = String(message.guild_id ?? b.guild_id ?? channel?.guild_id ?? "").trim()
  const guildName = String((b.guild_name ?? channel?.guild_name ?? "") || "").trim()
  const channelName = String(channel?.name ?? b.channel_name ?? "").trim()
  const isDm =
    Boolean(b.is_dm) ||
    channelType === 1 ||
    channelType === 3 ||
    (!guildId && Number.isNaN(channelType))

  const content =
    renderDiscordUserMentions(body, String(message.content ?? b.content ?? "")).trim() ||
    "(no text content)"
  const triggeredAt = new Date().toISOString()
  const createdAt = asIsoTimestamp(message.timestamp ?? b.timestamp, triggeredAt)
  const timestamp = formatDiscordTimestamp(createdAt)
  const member =
    typeof message.member === "object" && message.member
      ? (message.member as Record<string, unknown>)
      : typeof b.member === "object" && b.member
      ? (b.member as Record<string, unknown>)
      : null
  const authorName = String(
    member?.display_name ??
      member?.displayName ??
      member?.nickname ??
      member?.nick ??
      author?.global_name ??
      author?.globalName ??
      author?.username ??
      b.author_username ??
      b.author ??
      "unknown",
  )
  const authorId = String(author?.id ?? b.author_id ?? "")
  let pronouns = ""
  if (authorId) {
    const cached = options.pronouns ? options.pronouns(authorId) : null
    if (cached) pronouns = cached
  }
  const pronounsSuffix = pronouns ? ` (${pronouns})` : ""

  const channelId = String(message.channel_id ?? b.channel_id ?? channel?.id ?? "unknown")
  const messageId = String(message.id ?? b.message_id ?? "unknown")
  const friendlyId = channelId !== "unknown" && messageId !== "unknown" && options.friendlyId
    ? options.friendlyId(messageId, channelId)
    : null
  const location = isDm
    ? "DM"
    : `${guildName || "Discord"}/#${channelName || "channel"}`
  const header = isDm ? "[discord/dm]" : "[discord/channel]"
  const action = isDm
    ? "This is a direct message. Reply if it needs a response."
    : "This message was shared with everyone in the channel. Reply if there is something useful to add or the conversation seems directed at you; otherwise, no reply is needed."
  const replyLine = replyContextLine(message, b, options)
  const imageBlock = formatImageBlock(extractImageAttachments(body), options.modelVision === true)
  const fileBlock = formatFileBlock(extractFileAttachments(body))
  const userBlock = `<user>\n${content}\n</user>`

  return {
    source: "discord",
    triggeredAt,
    content: `${header} ${authorName /*this should be their display name*/} (@${"" /*claude, please replace this with the user's *username*/})${pronounsSuffix}\ntarget: 1${friendlyId ? `\nid: ${friendlyId}` : ""}\ncontext: ${location}\ntimestamp: ${timestamp}${replyLine ? `\n${replyLine}` : ""}\naction: ${action}\n${userBlock}${imageBlock}${fileBlock}`,
    ...(channelId !== "unknown" && messageId !== "unknown"
      ? {
          discordTargets: [{
            position: 1,
            ...(friendlyId ? { friendlyId } : {}),
            channelId,
            messageId,
            itemId: messageId,
            content,
            createdAt,
          }],
        }
      : {}),
    raw: body,
  }
}

/** Formats a reaction add as a Discord wake event targeting the reacted-to message. */
export function fromDiscordReaction(body: unknown, options: DiscordTriggerOptions = defaultOptions): UserMessage {
  const root = asRecord(body) ?? {}
  const original = asRecord(root.message) ?? {}
  const reactor = asRecord(root.reactor) ?? {}
  const emoji = asRecord(root.emoji) ?? {}
  const originalAuthor = asRecord(original.author)
  const originalMember = asRecord(original.member)
  const originalAuthorName = String(
    originalMember?.display_name ??
      originalMember?.displayName ??
      originalMember?.nickname ??
      originalMember?.nick ??
      originalAuthor?.global_name ??
      originalAuthor?.globalName ??
      originalAuthor?.username ??
      "unknown",
  )
  const originalContent = renderDiscordUserMentions(body, String(original.content ?? "")).trim() || "(no text content)"
  const reaction = discordEmojiMarkup({
    id: asString(emoji.id),
    name: asString(emoji.name),
    animated: Boolean(emoji.animated),
  })
  const content = `reacted with ${reaction} to @${originalAuthorName}'s message:\n${originalContent}`
  const payload = {
    ...root,
    message: {
      ...original,
      content,
      timestamp: String(root.reacted_at ?? new Date().toISOString()),
      author: reactor,
      member: asRecord(root.reactor_member) ?? undefined,
      referenced_message: original,
    },
  }
  const event = fromDiscord(payload, options)
  for (const target of event.discordTargets ?? []) target.content = originalContent
  return event
}

/** Formats a debounced DM burst as one runner event without dropping earlier messages. */
export function fromDiscordMessages(bodies: readonly unknown[], options: DiscordTriggerOptions = defaultOptions): UserMessage {
  if (bodies.length === 0) throw new Error("at least one Discord message is required")
  const events = bodies.map((body) => fromDiscord(body, options))
  if (events.length === 1) return events[0]!

  const latest = events.at(-1)!
  return {
    source: "discord",
    triggeredAt: latest.triggeredAt,
    content: events.map((event, index) => event.content.replace(/^target:\s*1$/m, `target: ${index + 1}`)).join("\n\n[next discord message]\n\n"),
    discordTargets: events.flatMap((event, index) =>
      (event.discordTargets ?? []).map((target) => ({ ...target, position: index + 1 }))),
    raw: [...bodies],
  }
}
