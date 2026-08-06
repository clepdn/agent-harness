import OpenAI from "openai"
import { config } from "./config"
import { MEMORY_EMBEDDING_DIMENSIONS } from "./db"
import { openAIHeaders, openAIUserAgent } from "./openai-headers"

export const EMBEDDING_MODEL = config.embeddings.model
export const EMBEDDING_DIMENSIONS = config.embeddings.dimensions || MEMORY_EMBEDDING_DIMENSIONS

const embeddingHeaders = openAIHeaders([
  ["HTTP-Referer", config.embeddings.referer],
  ["X-Title", config.embeddings.title],
  ["User-Agent", openAIUserAgent(undefined)],
])

const embeddingClient = config.embeddings.api_key
  ? new OpenAI({
      baseURL: config.embeddings.base_url,
      apiKey: config.embeddings.api_key,
      defaultHeaders: embeddingHeaders,
    })
  : null

export function embeddingsConfigured(): boolean {
  return Boolean(embeddingClient) && EMBEDDING_DIMENSIONS > 0
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!embeddingClient || texts.length === 0) return []

  const response = await embeddingClient.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
    encoding_format: "float",
  })

  if (!Array.isArray(response.data)) {
    const keys = response && typeof response === "object" ? Object.keys(response).join(",") : typeof response
    throw new Error(`embedding response missing data array (model=${EMBEDDING_MODEL}, inputs=${texts.length}, keys=${keys || "none"})`)
  }

  return response.data.map((item) => item.embedding)
}
