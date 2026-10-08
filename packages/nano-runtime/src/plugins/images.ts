import type { Plugin } from "@nano/plugins"
import { markdownExcerptImageReferences, prepareContextImages } from "../context-images"
import { fetchRemoteImage } from "../remote-image"
import { nano, type ImageService } from "./api"
/** Publishes image materialization behind the active plugin generation. */
export function createImagesPlugin(): Plugin {
  return {
    id: "nano.images",
    requires: [nano.persistence],
    optional: [nano.discord],
    provides: [nano.images],
    apply(scope) {
      const discord = scope.optional(nano.discord)
      const home = scope.use(nano.persistence).home
      const service: ImageService = {
        prepareMessages: scope.guard((messages) => prepareContextImages(messages, discord ? { loadAvatar: discord.loadContextAvatar, loadEmoji: discord.loadContextEmoji } : undefined, home)),
        fetchRemoteImage: scope.guard(async (url, signal) => {
          const combined = AbortSignal.any([scope.signal, ...(signal ? [signal] : [])])
          combined.throwIfAborted()
          const image = await fetchRemoteImage(url, combined)
          combined.throwIfAborted()
          return image
        }),
        memoryExcerptImageReferences: scope.guard((text, documentPath) => markdownExcerptImageReferences(text, documentPath, home)),
      }
      return scope.provide(nano.images, service)
    },
  }
}

export const imagesPlugin = createImagesPlugin()
