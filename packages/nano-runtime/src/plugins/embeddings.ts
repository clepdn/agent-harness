import type { Plugin } from "@nano/plugins"
import { config } from "../config"
import { createEmbeddingsService } from "../embeddings"
import { nano } from "./api"

export const embeddingsPlugin: Plugin = {
  id: "nano.embeddings",
  provides: [nano.embeddings],
  apply(scope) {
    const embeddings = createEmbeddingsService(config.embeddings)
    const service = {
      model: embeddings.model,
      dimensions: embeddings.dimensions,
      configured: scope.guard(() => embeddings.configured()),
      embedTexts: scope.guard((texts: string[], signal?: AbortSignal) =>
        embeddings.embedTexts(texts, signal ? AbortSignal.any([scope.signal, signal]) : scope.signal)),
    }
    return scope.provide(nano.embeddings, service)
  },
}
