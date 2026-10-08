import type { Plugin, CordisContext } from "@nano/plugins"
import { config } from "@nano/runtime-api/config"
import { createEmbeddingsService } from "./embeddings"
import { nano } from "@nano/runtime-api"

export const embeddingsPlugin: Plugin.Object = {
  name: "nano.embeddings",
  provide: "nano.embeddings",
  apply(ctx: CordisContext) {
    const embeddings = createEmbeddingsService(config.embeddings)
    const controller = new AbortController()
    ctx.effect(() => () => controller.abort(), "nano.embeddings IO")
    const service = {
      model: embeddings.model,
      dimensions: embeddings.dimensions,
      configured: () => embeddings.configured(),
      embedTexts: (texts: string[], signal?: AbortSignal) =>
        embeddings.embedTexts(texts, signal ? AbortSignal.any([controller.signal, signal]) : controller.signal),
    }
    ctx.provide(nano.embeddings.name, service)
  },
}
export { createEmbeddingsService } from "./embeddings"
export type { EmbeddingsConfig, EmbeddingsService } from "@nano/runtime-api/contracts/embeddings"
