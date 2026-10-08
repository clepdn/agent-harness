import type { Plugin, CordisContext } from "@nano/plugins"
import { configSchema } from "@nano/plugins"
import { config } from "@nano/runtime-api/config"
import { createWebSearch, type WebSearch, type WebSearchResult } from "./web-search"
import { nano, type WebSearchService } from "@nano/runtime-api"

export interface WebSearchPluginConfig {
  readonly apiKey: string
}

function parseWebSearchConfig(raw: unknown): WebSearchPluginConfig {
  const options = raw && typeof raw === "object" ? raw as { apiKey?: unknown } : undefined
  const configuredKey = options && typeof options.apiKey === "string" ? options.apiKey.trim() : ""
  return { apiKey: configuredKey || config.web_search.exa_api_key }
}

export const webSearchPlugin: Plugin.Object<WebSearchPluginConfig> = {
  name: "nano.web-search",
  provide: "nano.web-search",
  Config: configSchema(parseWebSearchConfig),
  apply(ctx: CordisContext, { apiKey }) {
    const search = createWebSearch(apiKey)
    const controller = new AbortController()
    ctx.effect(() => () => controller.abort(), "nano.web-search IO")
    const service: WebSearchService = {
      webSearch: (query, numResults, includeText, signal) =>
        search(query, numResults, includeText, signal ? AbortSignal.any([controller.signal, signal]) : controller.signal),
    }
    ctx.provide(nano.webSearch.name, service)
  },
}
export { createWebSearch }
export type { WebSearch, WebSearchResult }
export type { WebSearchService } from "@nano/runtime-api/contracts/web-search"
