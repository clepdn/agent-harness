import OpenAI from "openai"
import { MEMORY_EMBEDDING_DIMENSIONS } from "@nano/runtime-api"
import type { EmbeddingsConfig, EmbeddingsService } from "@nano/runtime-api/contracts/embeddings"
import { openAIHeaders, openAIUserAgent } from "./openai-headers"

/** Construct an embeddings client owned by the plugin that installs it. */
export function createEmbeddingsService(config: EmbeddingsConfig): EmbeddingsService {
  const dimensions = config.dimensions || MEMORY_EMBEDDING_DIMENSIONS
  const headers = openAIHeaders([
    ["HTTP-Referer", config.referer],
    ["X-Title", config.title],
    ["User-Agent", openAIUserAgent(undefined)],
  ])
  const client = config.api_key
    ? new OpenAI({ baseURL: config.base_url, apiKey: config.api_key, defaultHeaders: headers })
    : null

  return {
    model: config.model,
    dimensions,
    configured: () => Boolean(client) && dimensions > 0,
    async embedTexts(texts, signal) {
      if (!client || texts.length === 0) return []
      const response = await client.embeddings.create({
        model: config.model,
        input: texts,
        dimensions,
        encoding_format: "float",
      }, { signal })
      if (!Array.isArray(response.data)) {
        const keys = response && typeof response === "object" ? Object.keys(response).join(",") : typeof response
        throw new Error(`embedding response missing data array (model=${config.model}, inputs=${texts.length}, keys=${keys || "none"})`)
      }
      return response.data.map((item) => item.embedding)
    },
  }
}
