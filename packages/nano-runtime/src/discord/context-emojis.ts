import { CDN } from "discord.js"
import { config } from "../config"
import { imageMime, type ContextImageAttachment, type ContextImageReference } from "../context-images"

type EmojiReference = Extract<ContextImageReference, { kind: "discord-emoji" }>

const cdn = new CDN()
const CUSTOM_EMOJI_RE = /<(a?):([A-Za-z0-9_]{2,32}):(\d{1,22})>/g

/** Extract custom Discord emoji markup from message text. */
export function discordEmojiReferences(text: string): EmojiReference[] {
  if (!config.discord.attach_emoji_bitmap || !text) return []
  const refs = new Map<string, EmojiReference>()
  for (const match of text.matchAll(CUSTOM_EMOJI_RE)) {
    const emojiId = match[3]!
    const name = match[2]!
    const animated = match[1] === "a"
    refs.set(emojiId, {
      kind: "discord-emoji",
      emojiId,
      name,
      animated,
      label: animated
        ? `First frame of animated Discord custom emoji :${name}:`
        : `Discord custom emoji :${name}:`,
    })
  }
  return [...refs.values()]
}

/** Download a PNG bitmap; animated custom emoji are intentionally flattened. */
export async function loadDiscordEmoji(ref: EmojiReference): Promise<ContextImageAttachment> {
  if (!/^\d{1,22}$/.test(ref.emojiId)) throw new Error("invalid Discord emoji id")
  const url = cdn.emoji(ref.emojiId, { extension: "png", size: 128 })
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" })
  if (!response.ok || !response.body) throw new Error("Discord emoji unavailable")

  const maxBytes = Math.min(config.context_images.max_bytes, 1_000_000)
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body.cancel()
    throw new Error("emoji bitmap too large")
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maxBytes) throw new Error("emoji bitmap too large")
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }

  const bytes = Buffer.concat(chunks)
  return {
    type: "image",
    key: `discord-emoji:${ref.emojiId}`,
    label: ref.label,
    data: bytes.toString("base64"),
    mimeType: imageMime(bytes),
  }
}
