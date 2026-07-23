import { test } from "node:test"
import assert from "node:assert/strict"
import type { BridgeConfig } from "./config"
import { resolveProviderName, hasUsageSupport, getUsageForModel } from "./usage"
import { fetchUmansUsage } from "./umans"

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    port: 4040,
    host: "127.0.0.1",
    providers: {
      umans: { base_url: "https://api.code.umans.ai/v1", api_key: "sk-umans" },
    },
    models: {
      "umans-glm-5.2": {
        id: "umans-glm-5.2",
        name: "umans-glm-5.2",
        provider: "umans",
        baseUrl: "https://api.code.umans.ai/v1",
        apiKey: "sk-umans",
        contextWindow: 200000,
      },
    },
    ...overrides,
  }
}

test("resolveProviderName routes name-prefixes before the registry", () => {
  const config = makeConfig()
  assert.equal(resolveProviderName(config, "gemini-2.5-pro"), "antigravity")
  assert.equal(resolveProviderName(config, "agy-fast"), "antigravity")
  assert.equal(resolveProviderName(config, "gpt-5"), "codex")
  assert.equal(resolveProviderName(config, "o3-mini"), "codex")
  assert.equal(resolveProviderName(config, "o4-mini"), "codex")
  assert.equal(resolveProviderName(config, "codex-large"), "codex")
})

test("resolveProviderName falls back to the discovered registry, else null", () => {
  const config = makeConfig()
  assert.equal(resolveProviderName(config, "umans-glm-5.2"), "umans")
  assert.equal(resolveProviderName(config, "who-dis"), null)
})

test("hasUsageSupport is true for umans, false for the closed antigravity", () => {
  assert.equal(hasUsageSupport("umans"), true)
  assert.equal(hasUsageSupport("antigravity"), false)
})

test("getUsageForModel returns null for an unconfigured provider", async () => {
  const config = makeConfig({ providers: {} })
  assert.equal(await getUsageForModel(config, "umans", "umans-glm-5.2"), null)
})

test("hasUsageSupport now covers codex + anthropic-oauth", () => {
  assert.equal(hasUsageSupport("codex"), true)
  assert.equal(hasUsageSupport("anthropic-oauth"), true)
  assert.equal(hasUsageSupport("antigravity"), false)
})

test("fetchUmansUsage normalizes used/hard_cap into percent + display", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init: any) => {
    assert.equal(url, "https://api.code.umans.ai/v1/usage")
    assert.equal(init.headers.Authorization, "Bearer sk-umans")
    return {
      ok: true,
      json: async () => ({
        usage: { requests_in_window: 123 },
        limits: { requests: { hard_cap: 400 } },
      }),
    } as any
  }) as any
  try {
    const usage = await fetchUmansUsage({ base_url: "https://api.code.umans.ai/v1", api_key: "sk-umans" })
    assert.ok(usage)
    assert.equal(usage!.display, "123/400")
    assert.equal(usage!.percent, 123 / 400)
    assert.deepEqual((usage!.stats as any).usage, { requests_in_window: 123 })
  } finally {
    globalThis.fetch = realFetch
  }
})

test("fetchUmansUsage returns null on a non-ok response", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) }) as any) as any
  try {
    assert.equal(await fetchUmansUsage({ base_url: "https://x/v1", api_key: "k" }), null)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("fetchUmansUsage returns null when credentials are missing", async () => {
  assert.equal(await fetchUmansUsage({ base_url: "https://x/v1" }), null)
  assert.equal(await fetchUmansUsage({ api_key: "k" }), null)
})
