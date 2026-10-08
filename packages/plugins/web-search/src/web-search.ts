import type { WebSearch, WebSearchResult } from "@nano/runtime-api/contracts/web-search"
export type { WebSearch, WebSearchResult } from "@nano/runtime-api/contracts/web-search"

const EXA_SEARCH_URL = "https://api.exa.ai/search"


interface ExaResultRaw {
  title?: string | null
  url?: string
  publishedDate?: string
  author?: string
  text?: string
  highlights?: string[]
}

/** Create an Exa search operation bound to one configured credential. */
export function createWebSearch(apiKey: string, fetcher: typeof fetch = fetch): WebSearch {
  return async (query, numResults = 5, includeText = false, signal) => {
    if (!apiKey) throw new Error("web search unavailable: no exa_api_key configured")
    const q = query.trim()
    if (!q) throw new Error("web search requires a non-empty query")
    const n = Math.max(1, Math.min(25, Math.round(numResults)))
    const body: Record<string, unknown> = { query: q, numResults: n, type: "auto" }
    if (includeText) body.contents = { highlights: { numSentences: 3, highlightsPerUrl: 2 } }

    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) abort()
    else signal?.addEventListener("abort", abort, { once: true })
    const timeout = setTimeout(() => controller.abort(), 20_000)
    let response: Response
    try {
      response = await fetcher(EXA_SEARCH_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      throw new Error(`exa request failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(`exa returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`)
    }
    const json = await response.json() as unknown as { results?: ExaResultRaw[] }
    const results = Array.isArray(json.results) ? json.results : []
    return results.map((result) => {
      const snippet = includeText
        ? (result.highlights?.length ? result.highlights.join(" … ") : result.text?.slice(0, 500))
        : result.text?.slice(0, 300)
      const output: WebSearchResult = {
        title: (result.title ?? "").trim() || "(untitled)",
        url: result.url ?? "",
      }
      if (result.publishedDate) output.publishedDate = result.publishedDate
      if (result.author) output.author = result.author
      if (snippet) output.snippet = snippet.trim()
      return output
    })
  }
}
