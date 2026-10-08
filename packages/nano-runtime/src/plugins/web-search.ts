import type { Plugin } from "@nano/plugins"
import { config } from "../config"
import { createWebSearch } from "../web-search"
import { nano, type WebSearchService } from "./api"

export interface WebSearchPluginConfig {
  readonly apiKey: string
}

export const webSearchPlugin: Plugin<WebSearchPluginConfig> = {
  id: "nano.web-search",
  provides: [nano.webSearch],
  validate(raw): WebSearchPluginConfig {
    const options = raw && typeof raw === "object" ? raw : undefined
    const configuredKey = options && "apiKey" in options && typeof options.apiKey === "string" ? options.apiKey.trim() : ""
    return { apiKey: configuredKey || config.web_search.exa_api_key }
  },
  apply(scope, { apiKey }) {
    const search = createWebSearch(apiKey)
    const service: WebSearchService = {
      webSearch: scope.guard((query, numResults, includeText, signal) =>
        search(query, numResults, includeText, signal ? AbortSignal.any([scope.signal, signal]) : scope.signal)),
    }
    return scope.provide(nano.webSearch, service)
  },
}
