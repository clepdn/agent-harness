/**
 * Prometheus metrics exporter for coral/niri-runtime.
 *
 * Maintains lightweight in-memory counters and gauges, exposed via a
 * simple HTTP server in Prometheus text exposition format.
 *
 * Standard convention: serve on a dedicated port (default 9100).
 */

import http from "http"
import type { Usage } from "./llm"

// ── Metric primitives ─────────────────────────────────────────────────────────

interface CounterEntry {
  value: number
  labels: Record<string, string>
}

interface GaugeEntry {
  value: number
  labels: Record<string, string>
}

const counters = new Map<string, CounterEntry[]>()
const gauges = new Map<string, GaugeEntry[]>()

function labelKey(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort()
  if (keys.length === 0) return ""
  return keys.map((k) => `${k}="${labels[k]}"`).join(",")
}

function findEntry<T extends { labels: Record<string, string> }>(
  entries: T[],
  labels: Record<string, string>,
): T | undefined {
  const key = labelKey(labels)
  return entries.find((e) => labelKey(e.labels) === key)
}

function incCounter(name: string, labels: Record<string, string> = {}, amount = 1): void {
  let entries = counters.get(name)
  if (!entries) {
    entries = []
    counters.set(name, entries)
  }
  let entry = findEntry(entries, labels)
  if (!entry) {
    entry = { value: 0, labels: { ...labels } }
    entries.push(entry)
  }
  entry.value += amount
}

function setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
  let entries = gauges.get(name)
  if (!entries) {
    entries = []
    gauges.set(name, entries)
  }
  let entry = findEntry(entries, labels)
  if (!entry) {
    entry = { value: 0, labels: { ...labels } }
    entries.push(entry)
  }
  entry.value = value
}

// ── Sliding window request tracking ───────────────────────────────────────────

const WINDOW_MS = 5 * 60 * 60 * 1000 // 5 hours
const requestTimestamps: number[] = []

function recordRequestTime(ts: number = Date.now()): void {
  requestTimestamps.push(ts)
  pruneRequestWindow(ts)
}

function pruneRequestWindow(now: number = Date.now()): number {
  const cutoff = now - WINDOW_MS
  while (requestTimestamps.length > 0 && requestTimestamps[0] < cutoff) {
    requestTimestamps.shift()
  }
  return requestTimestamps.length
}

// ── Public API ────────────────────────────────────────────────────────────────

const METRIC_HELP: Record<string, { help: string; type: string }> = {
  coral_llm_requests_total: { help: "Total LLM API requests", type: "counter" },
  coral_llm_tokens_total: { help: "Total tokens used", type: "counter" },
  coral_llm_cost_total: { help: "Total cost in dollars", type: "counter" },
  coral_llm_tokens_per_second: { help: "Latest tokens per second", type: "gauge" },
  coral_requests_in_window_calculated: { help: "Requests in the rolling 5h window (our calculation)", type: "gauge" },
  coral_requests_in_window_api: { help: "Requests in window as reported by the umans API", type: "gauge" },
  coral_provider_usage_ratio: { help: "Fraction (0-1) of the provider's usage budget consumed, from the bridge /v1/usage endpoint", type: "gauge" },
  coral_working: { help: "1 if agent is actively in a tool loop, 0 if idle", type: "gauge" },
}

/** Record an LLM API request completion with usage data. */
export function recordLlmRequest(
  model: string,
  outcome: "success" | "error",
  usage: Usage | null,
  tokensPerSecond?: number,
): void {
  incCounter("coral_llm_requests_total", { model, outcome })
  recordRequestTime()

  if (usage) {
    incCounter("coral_llm_tokens_total", { type: "input" }, usage.input)
    incCounter("coral_llm_tokens_total", { type: "output" }, usage.output)
    incCounter("coral_llm_tokens_total", { type: "cache_read" }, usage.cacheRead)
    incCounter("coral_llm_tokens_total", { type: "cache_write" }, usage.cacheWrite)
    incCounter("coral_llm_cost_total", {}, usage.cost.total)
  }

  if (tokensPerSecond !== undefined) {
    setGauge("coral_llm_tokens_per_second", tokensPerSecond)
  }

  // Update calculated window count
  setGauge("coral_requests_in_window_calculated", pruneRequestWindow())
}

/** Set the API-reported requests in window (from umans /v1/usage). */
export function setApiRequestsInWindow(count: number): void {
  setGauge("coral_requests_in_window_api", count)
}

/**
 * Set the provider usage ratio (0-1 consumed) for a provider/model, sourced
 * from the bridge's normalized /v1/usage endpoint. Works across providers
 * (umans, codex, anthropic) since it's the provider-agnostic `percent`.
 */
export function setProviderUsageRatio(provider: string, model: string, ratio: number): void {
  setGauge("coral_provider_usage_ratio", ratio, { provider, model })
}

/** Set the working flag (1 = active tool loop, 0 = idle). */
export function setPromWorking(active: boolean): void {
  setGauge("coral_working", active ? 1 : 0)
}

// ── Exposition format ──────────────────────────────────────────────────────────

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort()
  if (keys.length === 0) return ""
  return `{${keys.map((k) => `${k}="${labels[k]}"`).join(",")}}`
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
}

function renderMetrics(): string {
  const lines: string[] = []
  const allNames = new Set<string>([...counters.keys(), ...gauges.keys()])

  for (const name of [...allNames].sort()) {
    const meta = METRIC_HELP[name]
    if (!meta) continue
    lines.push(`# HELP ${name} ${meta.help}`)
    lines.push(`# TYPE ${name} ${meta.type}`)

    const counterEntries = counters.get(name)
    if (counterEntries) {
      for (const entry of counterEntries) {
        const safeLabels: Record<string, string> = {}
        for (const [k, v] of Object.entries(entry.labels)) safeLabels[k] = escapeLabelValue(v)
        lines.push(`${name}${formatLabels(safeLabels)} ${entry.value}`)
      }
    }

    const gaugeEntries = gauges.get(name)
    if (gaugeEntries) {
      for (const entry of gaugeEntries) {
        const safeLabels: Record<string, string> = {}
        for (const [k, v] of Object.entries(entry.labels)) safeLabels[k] = escapeLabelValue(v)
        lines.push(`${name}${formatLabels(safeLabels)} ${entry.value}`)
      }
    }
  }

  return lines.join("\n") + "\n"
}

// ── HTTP server ───────────────────────────────────────────────────────────────

let server: http.Server | null = null

export function startPrometheusServer(port: number = 9100): void {
  if (server) return

  server = http.createServer((req, res) => {
    if (req.url === "/metrics") {
      // Prune window on each scrape so stale entries don't inflate the count
      setGauge("coral_requests_in_window_calculated", pruneRequestWindow())

      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" })
      res.end(renderMetrics())
      return
    }

    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" })
      res.end("coral prometheus exporter\n")
      return
    }

    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("not found\n")
  })

  server.listen(port, () => {
    console.log(`[prometheus] exporter listening on :${port}/metrics`)
  })

  server.on("error", (err) => {
    console.error(`[prometheus] server error:`, err)
  })
}

export function stopPrometheusServer(): void {
  if (server) {
    server.close()
    server = null
  }
}
