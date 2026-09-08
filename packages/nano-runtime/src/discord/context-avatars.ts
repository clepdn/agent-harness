import { CDN } from "discord.js"
import { config } from "../config"
import { getDb, isDbInitialized } from "../db"
import { imageMime, type ContextImageAttachment, type ContextImageReference } from "../context-images"
import type { UserMessage } from "../types"

type AvatarReference = Extract<ContextImageReference, { kind: "discord-avatar" }>
const cdn = new CDN()
const validId = (id: string) => /^\d{1,22}$/.test(id)
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined

function profileReference(value: unknown): AvatarReference | undefined {
  const user = object(value)
  const id = String(user?.id ?? "")
  if (!validId(id) || id === config.discord.bot_user_id) return undefined
  const name = String(user?.global_name ?? user?.username ?? id)
  return {
    kind: "discord-avatar", userId: id, label: `Discord profile picture of @${name} (user ${id})`,
    ...(user?.avatar === null || typeof user?.avatar === "string" ? { avatar: user.avatar } : {}),
    ...(typeof user?.discriminator === "string" ? { discriminator: user.discriminator } : {}),
  }
}

/** Lookup only message rows actually surfaced, never mark avatars seen at ingestion. */
function storedReference(messageId?: string, authorId?: string): AvatarReference | undefined {
  if (!isDbInitialized()) return undefined
  const row = messageId
    ? getDb().prepare("select author_id, author_username, raw_json from discord_messages where message_id = ?").get(messageId)
    : getDb().prepare("select author_id, author_username, raw_json from discord_messages where author_id = ? order by created_at desc limit 1").get(authorId)
  const record = object(row)
  if (!record) return undefined
  let raw: Record<string, unknown> | undefined
  try { raw = object(JSON.parse(String(record.raw_json))) } catch { /* old rows may have no payload */ }
  const message = object(raw?.message) ?? raw
  return profileReference(object(message?.author) ?? { id: record.author_id, username: record.author_username })
}

function unique(refs: AvatarReference[]): AvatarReference[] {
  return [...new Map(refs.map((ref) => [ref.userId, ref])).values()]
}

export function discordEventImageReferences(event: UserMessage): ContextImageReference[] {
  if (!config.discord.include_user_avatars || event.source !== "discord") return []
  const refs: AvatarReference[] = []
  for (const raw of Array.isArray(event.raw) ? event.raw : [event.raw]) {
    const root = object(raw)
    const message = object(root?.message) ?? root
    const ref = profileReference(message?.author)
    if (ref) refs.push(ref)
    const reply = profileReference(object(message?.referenced_message)?.author)
    if (reply) refs.push(reply)
  }
  for (const match of event.content.matchAll(/\bsource_item_id\s*[:=]\s*(\d+)/g)) {
    const ref = storedReference(match[1])
    if (ref) refs.push(ref)
  }
  return unique(refs)
}

export function discordToolImageReferences(text: string): ContextImageReference[] {
  if (!config.discord.include_user_avatars) return []
  const refs: AvatarReference[] = []
  function visit(value: unknown): void {
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    const row = object(value)
    if (!row) return
    const messageId = String(row.message_id ?? row.source_item_id ?? row.item_id ?? "")
    const authorId = String(row.author_id ?? "")
    const ref = validId(messageId) ? storedReference(messageId)
      : validId(authorId) ? storedReference(undefined, authorId) ?? profileReference({ id: authorId, username: row.author_username })
      : undefined
    if (ref) refs.push(ref)
    for (const child of Object.values(row)) if (child && typeof child === "object") visit(child)
  }
  try { visit(JSON.parse(text)) } catch { /* not a message listing */ }
  return unique(refs)
}

export function botAvatarReference(): ContextImageReference[] {
  return config.discord.include_bot_avatar
    ? [{ kind: "discord-avatar", userId: config.discord.bot_user_id || "@me", own: true, label: "Your Discord bot profile picture" }]
    : []
}

export async function loadDiscordAvatar(ref: AvatarReference): Promise<ContextImageAttachment> {
  let id = ref.userId
  let avatar = ref.avatar
  let discriminator = ref.discriminator
  if (!validId(id) && id !== "@me") throw new Error("invalid Discord user id")
  if (avatar === undefined) {
    if (!config.discord.bot_token) throw new Error("Discord bot token unavailable")
    const response = await fetch(`https://discord.com/api/v10/users/${id}`, {
      headers: { Authorization: `Bot ${config.discord.bot_token}` }, signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error("Discord profile unavailable")
    const user = await response.json() as { id: string; avatar: string | null; discriminator?: string }
    if (!validId(user.id)) throw new Error("invalid Discord profile")
    id = user.id
    avatar = user.avatar
    discriminator = user.discriminator
  }
  if (avatar != null && !/^[a-zA-Z0-9_]+$/.test(avatar)) throw new Error("invalid Discord avatar hash")
  const defaultIndex = discriminator && discriminator !== "0"
    ? Number(discriminator) % 5 : Number((BigInt(id) >> 22n) % 6n)
  const url = avatar ? cdn.avatar(id, avatar, { extension: "png", size: 128 }) : cdn.defaultAvatar(defaultIndex)
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" })
  if (!response.ok || !response.body) throw new Error("Discord avatar unavailable")
  const maxBytes = Math.min(config.context_images.max_bytes, 1_000_000)
  if (Number(response.headers.get("content-length")) > maxBytes) { await response.body.cancel(); throw new Error("avatar too large") }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maxBytes) throw new Error("avatar too large")
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  const bytes = Buffer.concat(chunks)
  ref.userId = id
  return { type: "image", key: `discord-avatar:${id}`, label: ref.label, data: bytes.toString("base64"), mimeType: imageMime(bytes) }
}
