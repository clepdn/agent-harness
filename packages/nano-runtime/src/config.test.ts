import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const configUrl = new URL("./config.ts", import.meta.url).href

test("JSON config layers and secrets merge before preset resolution", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nano-json-config-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = [
    { agent: { env: "local" }, models: { primary: { provider: "openai", model: "base-model", base_url: "https://example.test/v1" } },
      model: { preset: "primary" }, discord: { scan_channel_ids: ["old"] } },
    { models: { primary: { model: "override-model", cache_lifetime_minutes: 30, respect_prompt_cache: true } },
      discord: { scan_channel_ids: ["new"] } },
    { models: { primary: { api_key: "test-preset-secret" } }, discord: { bot_token: "test-discord-secret" } },
  ].map((value, index) => {
    const file = path.join(root, `${index}.json`)
    writeFileSync(file, JSON.stringify(value))
    return file
  })
  const script = `
    import assert from "node:assert/strict"
    process.argv = [process.execPath, "test", "--config", ${JSON.stringify(files[0])},
      "--config=" + ${JSON.stringify(files[1])}, "--secrets", ${JSON.stringify(files[2])}]
    const { config, getModelPreset, redactSecrets } = await import(${JSON.stringify(configUrl)})
    assert.equal(config.model.model, "override-model")
    assert.equal(config.model.base_url, "https://example.test/v1")
    assert.equal(config.model.api_key, "test-preset-secret")
    assert.equal(config.model.cache_lifetime_minutes, 30)
    assert.equal(config.model.respect_prompt_cache, true)
    assert.deepEqual(config.discord.scan_channel_ids, ["new"])
    assert.equal(config.discord.bot_token, "test-discord-secret")
    assert.equal(getModelPreset("primary").api_key, "test-preset-secret")
    assert.equal(redactSecrets("test-preset-secret test-discord-secret"), "[redacted:model.api_key] [redacted:discord.bot_token]")
    assert.equal(process.env.OPENAI_API_KEY, undefined)
  `
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: { ...process.env, NANO_CONFIG: "", NANO_SECRETS: "", OPENAI_API_KEY: undefined }, encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
})

test("invalid secrets JSON fails startup without revealing its contents", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nano-json-secrets-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, "secrets.json")
  writeFileSync(file, '{"api_key":"test-private-value",}')
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `await import(${JSON.stringify(configUrl)})`], {
    env: { ...process.env, NANO_CONFIG: "", NANO_SECRETS: file }, encoding: "utf8",
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Invalid JSON configuration/)
  assert.doesNotMatch(result.stderr, /test-private-value/)
})
