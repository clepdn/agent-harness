import assert from "node:assert/strict"
import test from "node:test"
import { createPrometheusRegistry } from "./prometheus"

test("idle scrapes expire the rolling request window without clearing counters", (t) => {
  let now = 0
  t.mock.method(Date, "now", () => now)
  const registry = createPrometheusRegistry()
  registry.recordLlmRequest("offline", "success", null)
  const sample = (name: string): number => {
    const line = registry.render().split("\n").find((entry) => entry.startsWith(`${name} `) || entry.startsWith(`${name}{`))
    assert.ok(line, `missing metric ${name}`)
    return Number(line.slice(line.lastIndexOf(" ") + 1))
  }
  now = 5 * 60 * 60 * 1000
  assert.equal(sample("nano_requests_in_window_calculated"), 1)
  now += 1
  assert.equal(sample("nano_requests_in_window_calculated"), 0)
  assert.equal(sample("nano_llm_requests_total"), 1)
})
