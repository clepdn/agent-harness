import { config } from "./config"
import type { Model, ModelEffortCapabilities } from "./llm"

type CatalogModel = {
  id?: unknown
  owned_by?: unknown
  owner?: unknown
  provider?: unknown
  source?: unknown
  is_codex?: unknown
  supported_reasoning_levels?: unknown
  default_reasoning_level?: unknown
}

export interface BridgeModelMetadataTarget {
  model: Model
  apiKey?: string
}

export interface BridgeModelMetadataOptions {
  readonly bridgeUrl?: string
  readonly bridgeApiKey?: string
  readonly fetch?: typeof globalThis.fetch
}

export interface BridgeModelMetadataResource {
  readonly lookup: (modelId: string, baseUrl: string, explicitlyBridge?: boolean, apiKey?: string) => ModelEffortCapabilities | undefined
  initialize(targets: readonly BridgeModelMetadataTarget[], signal?: AbortSignal): Promise<void>
  hydrate(targets: readonly BridgeModelMetadataTarget[]): void
}

type CatalogRequest = { endpoint: string; apiKey: string; modelIds: Set<string> }
const REQUEST_TIMEOUT_MS = 5_000

function normalizeEndpoint(value: string): string { return value.trim().replace(/\/+$/, "") }
function catalogUrl(endpoint: string): string {
  const normalized = normalizeEndpoint(endpoint)
  return normalized.endsWith("/v1") ? `${normalized}/models` : `${normalized}/v1/models`
}
function cacheKey(endpoint: string, apiKey: string): string { return `${apiKey}\u0000${normalizeEndpoint(endpoint)}` }
function catalogEffort(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("effort" in value)) return undefined
  const effort = value.effort
  return typeof effort === "string" && effort.trim() ? effort.trim() : undefined
}
function codexOwned(entry: CatalogModel): boolean {
  if (entry.is_codex === true) return true
  return [entry.owned_by, entry.owner, entry.provider, entry.source].some((value) => typeof value === "string" && /^(?:codex|openai-codex)$/i.test(value.trim()))
}
function isGpt6Family(modelId: string): boolean { return /(?:^|[/])gpt-6(?:\.\d+)?(?:[-:].*)?$/i.test(modelId) }
function capabilitiesFrom(entry: CatalogModel): ModelEffortCapabilities | undefined {
  if (!Array.isArray(entry.supported_reasoning_levels)) return undefined
  const supportedEfforts = [...new Set(entry.supported_reasoning_levels.map(catalogEffort).filter((effort): effort is string => effort !== undefined))]
  if (!supportedEfforts.length) return undefined
  const defaultEffort = typeof entry.default_reasoning_level === "string" ? entry.default_reasoning_level.trim() : ""
  return {
    supportedEfforts,
    ...(defaultEffort ? { defaultEffort } : {}),
    changeMode: typeof entry.id === "string" && isGpt6Family(entry.id) && codexOwned(entry) ? "configuration-update" : "cache-reset",
  }
}
function parseCatalog(payload: unknown): CatalogModel[] {
  if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) return []
  return payload.data.filter((entry): entry is CatalogModel => !!entry && typeof entry === "object")
}

/** Create per-plugin bridge catalog discovery and capability cache. */
export function createBridgeModelMetadata(options: BridgeModelMetadataOptions = {}): BridgeModelMetadataResource {
  const bridgeUrl = normalizeEndpoint(options.bridgeUrl ?? config.llm_bridge_url)
  const bridgeApiKey = options.bridgeApiKey ?? config.llm_bridge_api_key
  const fetchImpl = options.fetch ?? globalThis.fetch
  const capabilitiesByCredentialAndEndpoint = new Map<string, Map<string, ModelEffortCapabilities>>()

  const endpointFor = (baseUrl: string, explicitlyBridge: boolean): string => normalizeEndpoint(explicitlyBridge && !baseUrl ? bridgeUrl : baseUrl)
  const isBridgeBacked = (baseUrl: string, explicitlyBridge: boolean): boolean => explicitlyBridge || (!!bridgeUrl && normalizeEndpoint(baseUrl) === bridgeUrl)
  const lookup = (modelId: string, baseUrl: string, explicitlyBridge = false, apiKey?: string): ModelEffortCapabilities | undefined => {
    if (!isBridgeBacked(baseUrl, explicitlyBridge)) return undefined
    const endpoint = endpointFor(baseUrl, explicitlyBridge)
    if (!endpoint) return undefined
    return capabilitiesByCredentialAndEndpoint.get(cacheKey(endpoint, apiKey?.trim() || bridgeApiKey))?.get(modelId)
  }
  const loadCatalog = async (request: CatalogRequest, signal?: AbortSignal): Promise<void> => {
    const headers: Record<string, string> = { Accept: "application/json" }
    if (request.apiKey) headers.Authorization = `Bearer ${request.apiKey}`
    try {
      const response = await fetchImpl(catalogUrl(request.endpoint), { headers, signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) })
      if (!response.ok) return
      const entries = parseCatalog(await response.json())
      const capabilities = new Map<string, ModelEffortCapabilities>()
      for (const entry of entries) {
        if (typeof entry.id !== "string" || !request.modelIds.has(entry.id)) continue
        const effortCapabilities = capabilitiesFrom(entry)
        if (effortCapabilities) capabilities.set(entry.id, effortCapabilities)
      }
      capabilitiesByCredentialAndEndpoint.set(cacheKey(request.endpoint, request.apiKey), capabilities)
    } catch (error) {
      if (signal?.aborted) throw error
    }
  }
  const initialize = async (targets: readonly BridgeModelMetadataTarget[], signal?: AbortSignal): Promise<void> => {
    const requests = new Map<string, CatalogRequest>()
    const add = (target: BridgeModelMetadataTarget) => {
      const model = target.model
      if (!isBridgeBacked(model.baseUrl, model.bridge ?? false)) return
      const endpoint = endpointFor(model.baseUrl, model.bridge ?? false)
      if (!endpoint) return
      const apiKey = target.apiKey?.trim() || bridgeApiKey
      const id = cacheKey(endpoint, apiKey)
      const request = requests.get(id) ?? { endpoint, apiKey, modelIds: new Set<string>() }
      request.modelIds.add(model.id)
      requests.set(id, request)
    }
    for (const target of targets) add(target)
    await Promise.all([...requests.values()].map((request) => loadCatalog(request, signal)))
    signal?.throwIfAborted()
  }
  return {
    lookup,
    initialize,
    hydrate(targets) {
      for (const target of targets) target.model.effortCapabilities = lookup(target.model.id, target.model.baseUrl, target.model.bridge, target.apiKey)
    },
  }
}
