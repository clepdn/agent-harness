import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fetchAnthropicUsage } from "./anthropic"

function withAuthFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "bridge-anthropic-"))
  const path = join(dir, "auth.json")
  writeFileSync(
    path,
    JSON.stringify({
      anthropic: { type: "oauth", refresh: "r", access: "live-access", expires: Date.now() + 3_600_000 },
    }),
  )
  return path
}

test("fetchAnthropicUsage polls /api/oauth/usage with the OAuth token + beta header", async () => {
  const authPath = withAuthFile()
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init: any) => {
    assert.equal(url, "https://api.anthropic.com/api/oauth/usage")
    assert.equal(init.headers.Authorization, "Bearer live-access")
    assert.equal(init.headers["anthropic-beta"], "oauth-2025-04-20")
    return {
      ok: true,
      json: async () => ({
        five_hour: { utilization: 42, resets_at: "2026-07-22T12:00:00Z" },
        seven_day: { utilization: 8, resets_at: "2026-07-29T00:00:00Z" },
      }),
    } as any
  }) as any
  try {
    const usage = await fetchAnthropicUsage({ auth_path: authPath })
    assert.ok(usage)
    assert.equal(usage!.percent, 42 / 100)
    assert.equal(usage!.display, "5h 42% 7d 8%")
    assert.equal((usage!.stats as any).five_hour.utilization, 42)
  } finally {
    globalThis.fetch = realFetch
    rmSync(authPath, { force: true })
  }
})

test("fetchAnthropicUsage returns null without an auth path", async () => {
  assert.equal(await fetchAnthropicUsage({ base_url: "https://api.anthropic.com" }), null)
})

test("fetchAnthropicUsage returns null on a non-ok response", async () => {
  const authPath = withAuthFile()
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) }) as any) as any
  try {
    assert.equal(await fetchAnthropicUsage({ auth_path: authPath }), null)
  } finally {
    globalThis.fetch = realFetch
    rmSync(authPath, { force: true })
  }
})
