/**
 * Web search via the Exa API (https://exa.ai).
 *
 * The tool is gated on config.web_search.exa_api_key: when the key is present
 * and non-empty, the web_search tool is registered in the catalog. Otherwise it
 * is omitted entirely so the model never sees a dead tool.
 */

import { config } from "./config"

const EXA_SEARCH_URL = "https://api.exa.ai/search"

/** True when an Exa API key is configured, enabling the web_search tool. */
export function isWebSearchAvailable(): boolean {
  return config.web_search.exa_api_key.length > 0
}

export interface WebSearchResult {
  title: string
  url: string
  publishedDate?: string
  author?: string
  snippet?: string
}

interface ExaResultRaw {
  title?: string | null
  url?: string
  publishedDate?: string
  author?: string
  text?: string
  highlights?: string[]
}

/**
 * Run a web search through Exa. Returns a compact structured result set.
 *
 * @param query        the search query
 * @param numResults   how many results to return (default 5, clamped 1..25)
 * @param includeText  when true, pull page contents (highlights) for each result
 */
export async function webSearch(
  query: string,
  numResults = 5,
  includeText = false,
): Promise<WebSearchResult[]> {
  const apiKey = config.web_search.exa_api_key
  if (!apiKey) throw new Error("web search unavailable: no exa_api_key configured")

  const q = query.trim()
  if (!q) throw new Error("web search requires a non-empty query")

  const n = Math.max(1, Math.min(25, Math.round(numResults)))

  const body: Record<string, unknown> = {
    query: q,
    numResults: n,
    // Let Exa decide neural vs keyword based on the query.
    type: "auto",
  }
  if (includeText) {
    // Ask for short highlights rather than full page dumps to keep results lean.
    body.contents = { highlights: { numSentences: 3, highlightsPerUrl: 2 } }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  let res: Response
  try {
    res = await fetch(EXA_SEARCH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    throw new Error(`exa request failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timeout)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`exa returned ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`)
  }

  const json = (await res.json()) as { results?: ExaResultRaw[] }
  const results = Array.isArray(json.results) ? json.results : []

  return results.map((r) => {
    const snippet = includeText
      ? (r.highlights && r.highlights.length ? r.highlights.join(" … ") : r.text?.slice(0, 500))
      : r.text?.slice(0, 300)
    const out: WebSearchResult = {
      title: (r.title ?? "").trim() || "(untitled)",
      url: r.url ?? "",
    }
    if (r.publishedDate) out.publishedDate = r.publishedDate
    if (r.author) out.author = r.author
    if (snippet) out.snippet = snippet.trim()
    return out
  })
}
