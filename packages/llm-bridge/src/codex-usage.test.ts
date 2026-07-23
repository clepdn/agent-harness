import { test } from "node:test"
import assert from "node:assert/strict"
import { recordCodexUsage, getCachedCodexUsage, __clearCodexUsageCache } from "./codex-usage"

test("getCachedCodexUsage is null before any completion populates the cache", () => {
  __clearCodexUsageCache()
  assert.equal(getCachedCodexUsage("codex"), null)
})

test("recordCodexUsage caches primary window from x-codex-* headers", () => {
  __clearCodexUsageCache()
  recordCodexUsage("codex", {
    "x-codex-primary-used-percent": "45.5",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": "1750000000",
    "x-codex-secondary-used-percent": "12",
    "x-codex-secondary-window-minutes": "10080",
  })
  const usage = getCachedCodexUsage("codex")
  assert.ok(usage)
  assert.equal(usage!.percent, 45.5 / 100)
  assert.equal(usage!.display, "5h 46%") // 300 min => "5h", rounded percent
  assert.equal((usage!.stats as any).primary.used_percent, 45.5)
  assert.equal((usage!.stats as any).secondary.used_percent, 12)
  assert.equal(typeof (usage!.stats as any).age_ms, "number")
})

test("recordCodexUsage is a no-op when headers carry no rate-limit data", () => {
  __clearCodexUsageCache()
  recordCodexUsage("codex", { "content-type": "application/json" })
  assert.equal(getCachedCodexUsage("codex"), null)
})

test("weekly-only window labels as days", () => {
  __clearCodexUsageCache()
  recordCodexUsage("codex", {
    "x-codex-primary-used-percent": "80",
    "x-codex-primary-window-minutes": "10080", // 7 days
  })
  assert.equal(getCachedCodexUsage("codex")!.display, "7d 80%")
})

test("percent without a known window omits the label", () => {
  __clearCodexUsageCache()
  recordCodexUsage("codex", { "x-codex-primary-used-percent": "33" })
  assert.equal(getCachedCodexUsage("codex")!.display, "33%")
})
