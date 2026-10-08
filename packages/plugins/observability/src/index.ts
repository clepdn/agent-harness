import type { AddressInfo } from "node:net"
import type { CordisContext, Plugin } from "@nano/plugins"
import { createPrometheusExporter, type PrometheusScrapeSource } from "./prometheus-exporter"
import { configSchema, getService, nano } from "@nano/runtime-api"
import type { MetricsService } from "@nano/runtime-api"
export interface ObservabilityPluginConfig {
  readonly port?: number
  readonly host?: string
}

export interface ObservabilityService {
  start(): Promise<void>
  close(): Promise<void>
  address(): AddressInfo | string | null
}

export function createObservabilityService(
  metrics: Pick<MetricsService, "renderPrometheus">,
  options: ObservabilityPluginConfig = {},
): ObservabilityService {
  const source: PrometheusScrapeSource = { render: () => metrics.renderPrometheus() }
  return createPrometheusExporter(source, options.port ?? 9100, options.host ?? "127.0.0.1")
}
export function createObservabilityPlugin(defaults: ObservabilityPluginConfig = {}): Plugin<ObservabilityPluginConfig> {
  return {
    name: "nano.observability",
    inject: [nano.metrics.name],
    Config: configSchema((raw) => {
      if (raw == null) return defaults
      if (typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("nano.observability config must be an object")
      const value = raw as ObservabilityPluginConfig
      if (value.port !== undefined && (!Number.isInteger(value.port) || value.port < 0 || value.port > 65535)) {
        throw new TypeError("nano.observability config.port must be from 0 to 65535")
      }
      if (value.host !== undefined && (typeof value.host !== "string" || !value.host.trim())) {
        throw new TypeError("nano.observability config.host must be a non-empty hostname")
      }
      return { ...defaults, ...value }
    }),
    async apply(ctx: CordisContext, config: ObservabilityPluginConfig) {
      const service = createObservabilityService(getService(ctx, nano.metrics), config)
      await service.start()
      return () => service.close()
    },
  }
}
