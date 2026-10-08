export interface EmbeddingsConfig {
  model: string
  dimensions: number
  base_url: string
  api_key: string
  referer: string
  title: string
}

export interface EmbeddingsService {
  readonly model: string
  readonly dimensions: number
  configured(): boolean
  embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]>
}
