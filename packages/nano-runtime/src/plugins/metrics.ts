import type { Plugin } from "@nano/plugins"
import type Database from "better-sqlite3"
import type { Usage } from "../llm"
import { createMetricsStore, type MetricsQuery, type MetricsStore, type MetricEventInput } from "../metrics"
import { createPrometheusRegistry, type PrometheusRegistry } from "../prometheus"
import { nano, type MetricsService, type PersistenceService } from "./api"

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

export function createMetricsPlugin(defaults: MetricsPluginConfig = {}): Plugin<MetricsPluginConfig> {
  return {
    id: "nano.metrics",
    requires: [nano.persistence],
    provides: [nano.metrics],
    validate(raw) {
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
    },
    apply(scope, config) {
      const persistence = scope.use(nano.persistence)
      const metrics = createMetricsService({ ...config, home: persistence.home, nanoDb: persistence.getDb(), persistence })
      scope.own(() => metrics.close())
      const service: MetricsService = {
        recordMetric: scope.guard((...args) => metrics.recordMetric(...args)),
        recordLlmRequest: scope.guard((...args) => metrics.recordLlmRequest(...args)),
        setApiRequestsInWindow: scope.guard((...args) => metrics.setApiRequestsInWindow(...args)),
        setProviderUsageRatio: scope.guard((...args) => metrics.setProviderUsageRatio(...args)),
        setWorking: scope.guard((...args) => metrics.setWorking(...args)),
        renderPrometheus: scope.guard(() => metrics.renderPrometheus()),
        detail: scope.guard((...args) => metrics.detail(...args)),
        discordDetail: scope.guard((...args) => metrics.discordDetail(...args)),
        list: scope.guard((...args) => metrics.list(...args)),
      }
      return scope.provide(nano.metrics, service)
    },
  }
}
export const metricsPlugin = createMetricsPlugin()
