export interface WebSearchResult {
  title: string
  url: string
  publishedDate?: string
  author?: string
  snippet?: string
}

export type WebSearch = (query: string, numResults?: number, includeText?: boolean, signal?: AbortSignal) => Promise<WebSearchResult[]>

export interface WebSearchService {
  webSearch: WebSearch
}
