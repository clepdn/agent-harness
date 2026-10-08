import type { Plugin, CordisContext } from "@nano/plugins"
import { markdownExcerptImageReferences, prepareContextImages } from "@nano/runtime-api/context-images"
import { fetchRemoteImage } from "@nano/runtime-api/remote-image"
import { findService, getService, nano, type ImageService } from "@nano/runtime-api"

export function createImagesPlugin(): Plugin.Object {
  return {
    name: "nano.images",
    inject: ["nano.persistence"],
    provide: "nano.images",
    apply(ctx: CordisContext) {
      const home = getService(ctx, nano.persistence).home
      const controller = new AbortController()
      ctx.effect(() => () => controller.abort(), "nano.images IO")
      const service: ImageService = {
        prepareMessages: (messages) => {
          const discord = findService(ctx, nano.discord)
          return prepareContextImages(messages, discord ? { loadAvatar: discord.loadContextAvatar, loadEmoji: discord.loadContextEmoji } : undefined, home)
        },
        fetchRemoteImage: async (url, signal) => {
          const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])
          combined.throwIfAborted()
          const image = await fetchRemoteImage(url, combined)
          combined.throwIfAborted()
          return image
        },
        memoryExcerptImageReferences: (text, documentPath) => markdownExcerptImageReferences(text, documentPath, home),
      }
      ctx.provide(nano.images.name, service)
    },
  }
}

export const imagesPlugin = createImagesPlugin()
