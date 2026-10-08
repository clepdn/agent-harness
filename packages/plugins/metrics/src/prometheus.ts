import type { PrometheusScrapeSource } from "@nano/runtime-api/contracts/metrics"
import type { Usage } from "@nano/runtime-api/llm"

interface CounterEntry {
  value: number
  labels: Record<string, string>
}
interface GaugeEntry {
  value: number
  labels: Record<string, string>
}



export interface PrometheusRegistry extends PrometheusScrapeSource {
  readonly counters: Map<string, CounterEntry[]>
  readonly gauges: Map<string, GaugeEntry[]>
  readonly requestTimestamps: number[]
  recordLlmRequest(model: string, outcome: "success" | "error", usage: Usage | null, tokensPerSecond?: number): void
  setApiRequestsInWindow(count: number): void
  setProviderUsageRatio(provider: string, model: string, ratio: number): void
  setWorking(active: boolean): void
}

const METRIC_HELP: Record<string, { help: string; type: "counter" | "gauge" }> = {
  nano_llm_requests_total: { help: "Total LLM API requests", type: "counter" },
  nano_llm_tokens_total: { help: "Total LLM tokens by token type", type: "counter" },
  nano_llm_cost_total: { help: "Total cost in dollars", type: "counter" },
  nano_llm_tokens_per_second: { help: "Latest tokens per second", type: "gauge" },
  nano_requests_in_window_calculated: { help: "Requests in the rolling 5h window (our calculation)", type: "gauge" },
  nano_requests_in_window_api: { help: "Requests in window as reported by the umans API", type: "gauge" },
  nano_provider_usage_ratio: { help: "Fraction (0-1) of the provider's usage budget consumed, from the bridge /v1/usage endpoint", type: "gauge" },
  nano_working: { help: "1 if agent is actively in a tool loop, 0 if idle", type: "gauge" },
}
const WINDOW_MS = 5 * 60 * 60 * 1000

function labelKey(labels: Record<string, string>): string {
  return Object.keys(labels).sort().map((key) => `${key}="${labels[key]}"`).join(",")
}

function findEntry<T extends { labels: Record<string, string> }>(entries: T[], labels: Record<string, string>): T | undefined {
  const key = labelKey(labels)
  return entries.find((entry) => labelKey(entry.labels) === key)
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort()
  if (keys.length === 0) return ""
  return `{${keys.map((key) => `${key}="${escapeLabelValue(labels[key] ?? "")}"`).join(",")}}`
}

function pruneRequestWindow(timestamps: number[], now = Date.now()): number {
  const cutoff = now - WINDOW_MS
  while (timestamps.length > 0 && timestamps[0]! < cutoff) timestamps.shift()
  return timestamps.length
}

export function createPrometheusRegistry(): PrometheusRegistry {
  const counters = new Map<string, CounterEntry[]>()
  const gauges = new Map<string, GaugeEntry[]>()
  const requestTimestamps: number[] = []

  const incCounter = (name: string, labels: Record<string, string> = {}, amount = 1): void => {
    let entries = counters.get(name)
    if (!entries) counters.set(name, (entries = []))
    let entry = findEntry(entries, labels)
    if (!entry) entries.push((entry = { value: 0, labels: { ...labels } }))
    entry.value += amount
  }
  const setGauge = (name: string, value: number, labels: Record<string, string> = {}): void => {
    let entries = gauges.get(name)
    if (!entries) gauges.set(name, (entries = []))
    let entry = findEntry(entries, labels)
    if (!entry) entries.push((entry = { value: 0, labels: { ...labels } }))
    entry.value = value
  }

  const registry: PrometheusRegistry = {
    counters,
    gauges,
    requestTimestamps,
    recordLlmRequest(model, outcome, usage, tokensPerSecond) {
      incCounter("nano_llm_requests_total", { model, outcome })
      requestTimestamps.push(Date.now())
      if (usage) {
        incCounter("nano_llm_tokens_total", { type: "input" }, usage.input)
        incCounter("nano_llm_tokens_total", { type: "output" }, usage.output)
        incCounter("nano_llm_tokens_total", { type: "cache_read" }, usage.cacheRead)
        incCounter("nano_llm_tokens_total", { type: "cache_write" }, usage.cacheWrite)
        incCounter("nano_llm_cost_total", {}, usage.cost.total)
      }
      if (tokensPerSecond !== undefined) setGauge("nano_llm_tokens_per_second", tokensPerSecond)
      setGauge("nano_requests_in_window_calculated", pruneRequestWindow(requestTimestamps))
    },
    setApiRequestsInWindow(count) {
      setGauge("nano_requests_in_window_api", count)
    },
    setProviderUsageRatio(provider, model, ratio) {
      setGauge("nano_provider_usage_ratio", ratio, { provider, model })
    },
    setWorking(active) {
      setGauge("nano_working", active ? 1 : 0)
    },
    render() {
      setGauge("nano_requests_in_window_calculated", pruneRequestWindow(requestTimestamps))
      const lines: string[] = []
      const names = [...new Set([...counters.keys(), ...gauges.keys()])].sort()
      for (const name of names) {
        const metadata = METRIC_HELP[name]
        if (!metadata) continue
        lines.push(`# HELP ${name} ${metadata.help}`, `# TYPE ${name} ${metadata.type}`)
        for (const entry of counters.get(name) ?? []) lines.push(`${name}${formatLabels(entry.labels)} ${entry.value}`)
        for (const entry of gauges.get(name) ?? []) lines.push(`${name}${formatLabels(entry.labels)} ${entry.value}`)
      }
      return `${lines.join("\n")}\n`
    },
  }
  return registry
}
