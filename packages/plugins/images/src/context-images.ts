import fs from "node:fs/promises"
import path from "node:path"
import { fromMarkdown } from "mdast-util-from-markdown"
import { NANO_HOME } from "@nano/runtime-api/agent-config"
import { config } from "@nano/runtime-api/config"
import type { Message } from "@nano/runtime-api/llm"
import type { ContextImageReference, ContextImageAttachment, ContextImageState, DiscordContextImageLoader } from "@nano/runtime-api/contracts/images"
import { imageMime } from "@nano/runtime-api/media"


function referenceEnabled(ref: ContextImageReference): boolean {
  return ref.kind === "markdown" ? config.context_images.markdown
    : ref.kind === "discord-emoji" ? config.discord.attach_emoji_bitmap
    : ref.own ? config.discord.include_bot_avatar : config.discord.include_user_avatars
}

function referenceKey(ref: ContextImageReference): string {
  return ref.kind === "markdown" ? `markdown:${ref.path}`
    : ref.kind === "discord-emoji" ? `discord-emoji:${ref.emojiId}`
    : `discord-avatar:${ref.userId}`
}

/** Recheck settings when restored sessions already contain image bytes. */
export function enabledContextImages(message: ContextImageState): ContextImageAttachment[] {
  if (message.imagesSuppressed) return []
  const keys = new Set(message.imageReferences?.filter(referenceEnabled).slice(0, config.context_images.max_per_message).map(referenceKey))
  return (message.imageAttachments ?? []).filter((image) => keys.has(image.key))
}

type MarkdownNode = { type: string; url?: string; alt?: string | null; identifier?: string; children?: MarkdownNode[]; position?: { start: { offset?: number }; end: { offset?: number } } }

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function withinHome(file: string, home = NANO_HOME): boolean {
  const relative = path.relative(home, file)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Resolve inline and reference-style Markdown images, ignoring code examples. */
export function markdownImageReferences(markdown: string, documentPath: string, fullDocument = markdown, home = NANO_HOME): ContextImageReference[] {
  if (!config.context_images.markdown) return []
  const definitions = new Map<string, string>()
  const definitionText: string[] = []
  walk(fromMarkdown(fullDocument), (node) => {
    if (node.type === "definition" && node.identifier && node.url) {
      definitions.set(node.identifier, node.url)
      definitionText.push(fullDocument.slice(node.position?.start.offset, node.position?.end.offset))
    }
  })
  const refs: ContextImageReference[] = []
  const seen = new Set<string>()
  walk(fromMarkdown(`${markdown}\n\n${definitionText.join("\n")}`), (node) => {
    const url = node.type === "image" ? node.url : node.type === "imageReference" ? definitions.get(node.identifier ?? "") : undefined
    if (!url || url.startsWith("//") || (/^[a-z][a-z\d+.-]*:/i.test(url) && !url.startsWith("memory://"))) return
    let decoded: string
    try { decoded = decodeURIComponent(url) } catch { return }
    const file = decoded.startsWith("memory://")
      ? path.resolve(home, "memories", decoded.slice("memory://".length))
      : path.resolve(path.dirname(documentPath), decoded)
    if (!withinHome(file, home) || seen.has(file)) return
    seen.add(file)
    refs.push({ kind: "markdown", path: file, label: `${node.alt || "Image"} — ${url} (from ${path.relative(home, documentPath)})` })
  })
  return refs
}

/** Also use definitions outside a selected excerpt, without loading their images. */
export async function markdownExcerptImageReferences(markdown: string, documentPath: string, home = NANO_HOME): Promise<ContextImageReference[]> {
  if (!config.context_images.markdown || !withinHome(documentPath, home)) return []
  const realPath = await fs.realpath(documentPath).catch(() => documentPath)
  const realHome = await fs.realpath(home).catch(() => home)
  if (!withinHome(realPath, realHome)) return []
  const full = await fs.readFile(documentPath, "utf8").catch(() => markdown)
  return markdownImageReferences(markdown, documentPath, full, home)
}


async function loadLocalImage(ref: Extract<ContextImageReference, { kind: "markdown" }>, imageHome: string): Promise<ContextImageAttachment> {
  const [home, file] = await Promise.all([fs.realpath(imageHome), fs.realpath(ref.path)])
  if (!withinHome(file, home)) throw new Error("image resolves outside the agent home")
  const handle = await fs.open(file, "r")
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > config.context_images.max_bytes) throw new Error("image is not a file or exceeds the image size limit")
    const bytes = await handle.readFile()
    if (bytes.length > config.context_images.max_bytes) throw new Error("image exceeds the image size limit")
    return { type: "image", key: `markdown:${ref.path}`, label: ref.label, data: bytes.toString("base64"), mimeType: imageMime(bytes) }
  } finally {
    await handle.close()
  }
}

/** Keep text intact for routing/recall; materialize image bytes only for vision requests. */
export async function prepareContextImages(messages: Message[], loaders?: DiscordContextImageLoader, home = NANO_HOME): Promise<void> {

  const seenDiscordImages = new Set<string>()
  for (const message of messages) {
    if (message.role === "assistant" || message.imagesSuppressed) continue
    for (const image of enabledContextImages(message)) {
      if (image.key.startsWith("discord-avatar:") || image.key.startsWith("discord-emoji:")) seenDiscordImages.add(image.key)
    }
    const refs = (message.imageReferences ?? []).filter(referenceEnabled)
    if (refs.length === 0) continue
    const loaded = new Set(message.imageAttachments?.map((image) => image.key))
    const notes = new Set(message.imageNotes)
    for (const ref of refs.slice(0, config.context_images.max_per_message)) {
      const key = referenceKey(ref)
      const discordImage = ref.kind === "discord-avatar" || ref.kind === "discord-emoji"
      if (loaded.has(key) || (discordImage && seenDiscordImages.has(key))) continue
      const failure = `[image unavailable: ${ref.label}]`
      if (notes.has(failure)) continue
      try {
        const image = ref.kind === "markdown" ? await loadLocalImage(ref, home)
          : ref.kind === "discord-emoji" ? await loaders?.loadEmoji(ref)
          : await loaders?.loadAvatar(ref)
        if (!image) throw new Error("Discord image loader unavailable")
        // @me may resolve to a user already pictured in this context.
        if (discordImage && seenDiscordImages.has(image.key)) continue
        ;(message.imageAttachments ??= []).push(image)
        loaded.add(image.key)
        if (discordImage) seenDiscordImages.add(image.key)
      } catch {
        notes.add(failure)
      }
    }
    if (refs.length > config.context_images.max_per_message) notes.add(`[image limit: showing at most ${config.context_images.max_per_message} images for this message]`)
    if (notes.size > 0) message.imageNotes = [...notes]
  }
}
