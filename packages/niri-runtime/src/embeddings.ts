import OpenAI from "openai"
import { config } from "./config"
import { MEMORY_EMBEDDING_DIMENSIONS } from "./db"

export const EMBEDDING_MODEL = config.embeddings.model
export const EMBEDDING_DIMENSIONS = config.embeddings.dimensions || MEMORY_EMBEDDING_DIMENSIONS

const embeddingClient = config.embeddings.api_key
  ? new OpenAI({
      baseURL: config.embeddings.base_url,
      apiKey: config.embeddings.api_key,
      defaultHeaders: {
        ...(config.embeddings.referer ? { "HTTP-Referer": config.embeddings.referer } : {}),
        ...(config.embeddings.title ? { "X-Title": config.embeddings.title } : {}),
      },
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

  return response.data.map((item) => item.embedding)
}
