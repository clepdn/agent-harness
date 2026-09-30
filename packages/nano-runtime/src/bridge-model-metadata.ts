import { config, getModelPreset, listModelPresets } from "./config"
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

type CatalogRequest = { endpoint: string; apiKey: string; modelIds: Set<string> }

const REQUEST_TIMEOUT_MS = 5_000
const capabilitiesByCredentialAndEndpoint = new Map<string, Map<string, ModelEffortCapabilities>>()

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

function catalogUrl(endpoint: string): string {
  const normalized = normalizeEndpoint(endpoint)
  return normalized.endsWith("/v1") ? `${normalized}/models` : `${normalized}/v1/models`
}

function cacheKey(endpoint: string, apiKey: string): string {
  return `${apiKey}\u0000${normalizeEndpoint(endpoint)}`
}

function catalogEffort(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("effort" in value)) return undefined
  const effort = value.effort
  return typeof effort === "string" && effort.trim() ? effort.trim() : undefined
}

function codexOwned(entry: CatalogModel): boolean {
  if (entry.is_codex === true) return true
  return [entry.owned_by, entry.owner, entry.provider, entry.source].some((value) =>
    typeof value === "string" && /^(?:codex|openai-codex)$/i.test(value.trim()),
  )
}

function isGpt6Family(modelId: string): boolean {
  return /(?:^|[/])gpt-6(?:\.\d+)?(?:[-:].*)?$/i.test(modelId)
}

function capabilitiesFrom(entry: CatalogModel): ModelEffortCapabilities | undefined {
  if (!Array.isArray(entry.supported_reasoning_levels)) return undefined
  const supportedEfforts = [...new Set(entry.supported_reasoning_levels
    .map(catalogEffort)
    .filter((effort): effort is string => effort !== undefined))]
  if (supportedEfforts.length === 0) return undefined
  const defaultEffort = typeof entry.default_reasoning_level === "string"
    ? entry.default_reasoning_level.trim()
    : ""
  return {
    supportedEfforts,
    ...(defaultEffort ? { defaultEffort } : {}),
    changeMode: typeof entry.id === "string" && isGpt6Family(entry.id) && codexOwned(entry)
      ? "configuration-update"
      : "cache-reset",
  }
}

function catalogRequests(): Map<string, CatalogRequest> {
  const requests = new Map<string, CatalogRequest>()
  const add = (modelId: unknown, baseUrl: unknown, explicitlyBridge: unknown, apiKey: unknown) => {
    if (typeof modelId !== "string" || !modelId.trim()) return
    const url = typeof baseUrl === "string" ? baseUrl.trim() : ""
    const isConfiguredBridge = !!config.llm_bridge_url &&
      normalizeEndpoint(url) === normalizeEndpoint(config.llm_bridge_url)
    if (explicitlyBridge !== true && !isConfiguredBridge) return
    const endpoint = normalizeEndpoint(explicitlyBridge === true && !url ? config.llm_bridge_url : url)
    if (!endpoint) return
    const key = typeof apiKey === "string" && apiKey.trim()
      ? apiKey.trim()
      : config.llm_bridge_api_key
    const requestId = cacheKey(endpoint, key)
    let request = requests.get(requestId)
    if (!request) {
      request = { endpoint, apiKey: key, modelIds: new Set() }
      requests.set(requestId, request)
    }
    request.modelIds.add(modelId.trim())
  }

  for (const section of [config.model, config.fallback, config.summary]) {
    add(section.model, section.base_url, section.bridge, section.api_key)
  }
  for (const name of listModelPresets()) {
    const preset = getModelPreset(name)
    if (preset) add(preset.model, preset.base_url, preset.bridge, preset.api_key)
  }
  return requests
}

function parseCatalog(payload: unknown): CatalogModel[] {
  if (!payload || typeof payload !== "object" || !("data" in payload)) return []
  const data = payload.data
  if (!Array.isArray(data)) return []
  return data.filter((entry): entry is CatalogModel => !!entry && typeof entry === "object")
}

async function loadCatalog(request: CatalogRequest): Promise<void> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (request.apiKey) headers.Authorization = `Bearer ${request.apiKey}`
  try {
    const response = await fetch(catalogUrl(request.endpoint), {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return
    const entries = parseCatalog(await response.json())
    const capabilities = new Map<string, ModelEffortCapabilities>()
    for (const entry of entries) {
      if (typeof entry.id !== "string" || !request.modelIds.has(entry.id)) continue
      const effortCapabilities = capabilitiesFrom(entry)
      if (effortCapabilities) capabilities.set(entry.id, effortCapabilities)
    }
    capabilitiesByCredentialAndEndpoint.set(cacheKey(request.endpoint, request.apiKey), capabilities)
  } catch {
    // Optional metadata must never make bridge model configuration fatal.
  }
}

export function isBridgeBackedModel(baseUrl: string, explicitlyBridge = false): boolean {
  return explicitlyBridge || (!!config.llm_bridge_url &&
    normalizeEndpoint(baseUrl) === normalizeEndpoint(config.llm_bridge_url))
}

export function bridgeEffortCapabilities(
  modelId: string,
  baseUrl: string,
  explicitlyBridge = false,
  apiKey?: string,
): ModelEffortCapabilities | undefined {
  if (!isBridgeBackedModel(baseUrl, explicitlyBridge)) return undefined
  const endpoint = normalizeEndpoint(explicitlyBridge && !baseUrl ? config.llm_bridge_url : baseUrl)
  const credential = apiKey?.trim() || config.llm_bridge_api_key
  return capabilitiesByCredentialAndEndpoint.get(cacheKey(endpoint, credential))?.get(modelId)
}

/** Discover configured bridge catalogs before startup; cached builds then hydrate synchronously. */
export async function initializeBridgeModelMetadata(targets: readonly BridgeModelMetadataTarget[] = []): Promise<void> {
  await Promise.all([...catalogRequests().values()].map(loadCatalog))
  for (const { model, apiKey } of targets) {
    const capabilities = bridgeEffortCapabilities(model.id, model.baseUrl, model.bridge, apiKey)
    model.effortCapabilities = capabilities
  }
}
