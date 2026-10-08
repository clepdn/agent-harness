import type { Plugin, CordisContext } from "@nano/plugins"
import { configSchema } from "@nano/plugins"
import type Database from "better-sqlite3"
import type { Usage } from "@nano/runtime-api/llm"
import { createMetricsStore, type MetricsQuery, type MetricsStore, type MetricEventInput } from "@nano/runtime-api/metrics"
import { createPrometheusRegistry, type PrometheusRegistry } from "@nano/runtime-api/prometheus"
import { getService, nano, type MetricsService, type PersistenceService } from "@nano/runtime-api"

export interface MetricsPluginConfig {
  readonly path?: string
  readonly retentionDays?: number
}

export interface MetricsServiceOptions extends MetricsPluginConfig {
  readonly nanoDb: Database.Database
  readonly home?: string
  readonly persistence: Pick<PersistenceService, "publishWorkerEvent">
}

export function createMetricsService(options: MetricsServiceOptions): MetricsService & { close(): void } {
  const registry: PrometheusRegistry = createPrometheusRegistry()
  const store: MetricsStore = createMetricsStore({
    path: options.path,
    retentionDays: options.retentionDays,
    nanoDb: options.nanoDb,
    home: options.home,
  })
  const recordMetric = (metric: MetricEventInput): number | null => {
    const id = store.recordMetric(metric)
    if (id === null) return null
    const recorded = store.getMetricDetail(id)
    if (recorded) {
      try {
        options.persistence.publishWorkerEvent("metric.recorded", recorded)
      } catch (error) {
        console.error("[metrics] failed to publish metric event:", error)
      }
    }
    return id
  }
  return {
    recordMetric,
    recordLlmRequest: (model: string, status: "success" | "error", usage: Usage | null, tokensPerSecond?: number) =>
      registry.recordLlmRequest(model, status, usage, tokensPerSecond),
    setApiRequestsInWindow: (count: number) => registry.setApiRequestsInWindow(count),
    setProviderUsageRatio: (provider: string, model: string, ratio: number) => registry.setProviderUsageRatio(provider, model, ratio),
    setWorking: (working: boolean) => registry.setWorking(working),
    renderPrometheus: () => registry.render(),
    detail: (id: number) => store.getMetricDetail(id),
    discordDetail: (id: string) => store.getDiscordMetricDetail(id),
    list: (query?: MetricsQuery) => store.getMetrics(query),
    close: () => store.close(),
  }
}

function parseMetricsConfig(raw: unknown, defaults: MetricsPluginConfig): MetricsPluginConfig {
  if (raw == null) return defaults
  if (typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("nano.metrics config must be an object")
  const value = raw as MetricsPluginConfig
  if (value.path !== undefined && (typeof value.path !== "string" || !value.path.trim())) {
    throw new TypeError("nano.metrics config.path must be a non-empty path")
  }
  if (value.retentionDays !== undefined && (!Number.isFinite(value.retentionDays) || value.retentionDays <= 0)) {
    throw new TypeError("nano.metrics config.retentionDays must be positive")
  }
  return { ...defaults, ...value }
}

export function createMetricsPlugin(defaults: MetricsPluginConfig = {}): Plugin.Object<MetricsPluginConfig> {
  return {
    name: "nano.metrics",
    inject: ["nano.persistence"],
    provide: "nano.metrics",
    Config: configSchema((raw) => parseMetricsConfig(raw, defaults)),
    apply(ctx: CordisContext, config) {
      const persistence = getService(ctx, nano.persistence)
      const metrics = createMetricsService({ ...config, home: persistence.home, nanoDb: persistence.getDb(), persistence })
      const service: MetricsService = {
        recordMetric: (...args) => metrics.recordMetric(...args),
        recordLlmRequest: (...args) => metrics.recordLlmRequest(...args),
        setApiRequestsInWindow: (...args) => metrics.setApiRequestsInWindow(...args),
        setProviderUsageRatio: (...args) => metrics.setProviderUsageRatio(...args),
        setWorking: (...args) => metrics.setWorking(...args),
        renderPrometheus: () => metrics.renderPrometheus(),
        detail: (...args) => metrics.detail(...args),
        discordDetail: (...args) => metrics.discordDetail(...args),
        list: (...args) => metrics.list(...args),
      }
      return (function* () {
        yield () => metrics.close()
        yield ctx.provide(nano.metrics.name, service)
      })()
    },
  }
}
export const metricsPlugin = createMetricsPlugin()
