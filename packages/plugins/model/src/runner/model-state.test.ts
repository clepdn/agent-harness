import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// Fresh subprocesses dynamically load these modules so each test owns its config singleton.
const modelStateUrl = new URL("./model-state.ts", import.meta.url).href
const llmUrl = import.meta.resolve("@nano/runtime-api/llm")
const providerUrl = import.meta.resolve("@nano/plugin-model/provider")

async function runWithConfig(configValue: Record<string, unknown>, script: string, timeoutMs?: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-model-factory-"))
  const configPath = path.join(root, "config.json")
  await fs.writeFile(configPath, JSON.stringify(configValue), "utf8")
  try {
    let resolve!: (value: { code: number | null; stdout: string; stderr: string }) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<{ code: number | null; stdout: string; stderr: string }>((res, rej) => { resolve = res; reject = rej })
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      timeout: timeoutMs,
      env: { ...process.env, NANO_CONFIG: configPath, NANO_HOME: path.join(root, "home") },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
    return await promise
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
async function runInHome(home: string, configValue: Record<string, unknown>, script: string, timeoutMs?: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  await fs.mkdir(home, { recursive: true })
  const configPath = path.join(home, "config.json")
  await fs.writeFile(configPath, JSON.stringify(configValue), "utf8")
  let resolve!: (value: { code: number | null; stdout: string; stderr: string }) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<{ code: number | null; stdout: string; stderr: string }>((res, rej) => { resolve = res; reject = rej })
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    timeout: timeoutMs,
    env: { ...process.env, NANO_CONFIG: configPath, NANO_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
  child.on("error", reject)
  child.on("close", (code) => resolve({ code, stdout, stderr }))
  return await promise
}

const baseConfig = {
  agent: { env: "production" },
  model: { provider: "openai", model: "main-model", api_key: "test-key", idle_compaction_minutes: 1 },
}

test("preset swaps hydrate bridge metadata across endpoints and restore capability", async () => {
  const result = await runWithConfig({ ...baseConfig, models: {
    alpha: { provider: "openai", model: "gpt-6-alpha", base_url: "https://bridge-a.invalid/v1", api_key: "alpha-key", bridge: true },
    beta: { provider: "openai", model: "gpt-6-beta", base_url: "https://bridge-b.invalid/v1", api_key: "beta-key", bridge: true },
  } }, `
    import assert from "node:assert/strict"
    const { createModelStateFactory } = await import(${JSON.stringify(modelStateUrl)})
    const { createBridgeModelMetadata } = await import(${JSON.stringify(new URL("../bridge-model-metadata.ts", import.meta.url).href)})
    const { Context } = await import(${JSON.stringify(llmUrl)})
    const catalogs = {
      "https://bridge-a.invalid/v1/models": { data: [{ id: "gpt-6-alpha", is_codex: true, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }], default_reasoning_level: "low" }] },
      "https://bridge-b.invalid/v1/models": { data: [{ id: "gpt-6-beta", is_codex: true, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }], default_reasoning_level: "low" }] },
    }
    const fetchCatalog = async input => {
      const catalog = catalogs[String(input)]
      if (!catalog) throw new Error("unexpected catalog request: " + String(input))
      return Response.json(catalog)
    }
    const createMetadata = () => createBridgeModelMetadata({ fetch: fetchCatalog })
    const resource = await createModelStateFactory({ home: process.env.NANO_HOME || ".", metadata: createMetadata() })
    const alpha = resource.resolveModelSwap("alpha")
    const beta = resource.resolveModelSwap("beta")
    for (const selection of [alpha, beta]) {
      const context = new Context({ model: selection.model, thinkingLevel: "low", items: [{ role: "user", content: "start", timestamp: 0 }] })
      assert.deepEqual([...context.availableEfforts], ["low", "high", "max"])
      assert.equal(context.effortChangeMode, "configuration-update")
      const lineageId = context.id
      assert.equal(context.changeEffort("high"), context)
      assert.equal(context.id, lineageId)
      assert.deepEqual(context.effortState.updates, [{ beforeMessageIndex: 1, effort: "high" }])
      const restored = Context.restore({ model: selection.model, id: context.id, items: context.snapshot(), effortState: context.effortState })
      restored.append({ role: "user", content: "continue", timestamp: 1 })
      assert.equal(restored.changeEffort("max"), restored)
      assert.equal(restored.id, lineageId)
    }
    await resource.persistModelSwap(beta)
    const reopened = await createModelStateFactory({ home: process.env.NANO_HOME || ".", metadata: createMetadata() })
    assert.equal(reopened.persistedPreset(), "beta")
    assert.equal(reopened.current().primaryModel?.id, "gpt-6-beta")
    const restoredContext = new Context({ model: reopened.current().primaryModel, thinkingLevel: "low" })
    assert.deepEqual([...restoredContext.availableEfforts], ["low", "high", "max"])
    assert.equal(restoredContext.effortChangeMode, "configuration-update")
    assert.equal(restoredContext.changeEffort("high"), restoredContext)
  `, 15_000)
  assert.equal(result.code, 0, result.stderr)
})

test("fallback and summary requests retain their configured attribution headers", async () => {
  const result = await runWithConfig({
    ...baseConfig,
    fallback: { provider: "openai", model: "fallback-model", base_url: "https://fallback.invalid/v1", api_key: "offline", referer: "https://fallback-client.invalid", title: "Fallback client" },
    summary: { provider: "openai", model: "summary-model", base_url: "https://summary.invalid/v1", api_key: "offline", referer: "https://summary-client.invalid", title: "Summary client" },
  }, `
    import assert from "node:assert/strict"
    const { createModelStateFactory } = await import(${JSON.stringify(modelStateUrl)})
    const { createOpenAICompatibleModelProvider } = await import(${JSON.stringify(providerUrl)})
    const requests = []
    globalThis.fetch = async (_url, init) => {
      requests.push(new Headers(init.headers))
      return Response.json({ choices: [{ message: { content: "offline result" }, finish_reason: "stop" }] })
    }
    const resource = await createModelStateFactory({ home: process.env.NANO_HOME || "." })
    const provider = createOpenAICompatibleModelProvider()
    for (const [model, apiKey] of [[resource.current().fallbackModel, resource.current().fallbackApiKey], [resource.current().summaryModel, resource.current().summaryApiKey]]) {
      assert.ok(model)
      await provider.complete(model, { messages: [{ role: "user", content: "offline", timestamp: 0 }] }, { apiKey })
    }
    assert.deepEqual(requests.map(headers => [headers.get("HTTP-Referer"), headers.get("X-Title")]), [
      ["https://fallback-client.invalid", "Fallback client"],
      ["https://summary-client.invalid", "Summary client"],
    ])
  `)
  assert.equal(result.code, 0, result.stderr)
})

test("undefined frontend preset live-inherits the mutable main state", async () => {
  const result = await runWithConfig({ ...baseConfig, frontend: { enable: true } }, `
    const { createModelStateFactory } = await import(${JSON.stringify(modelStateUrl)})
    const resource = await createModelStateFactory({ home: process.env.NANO_HOME || "." })
    const main = resource.current()
    if (resource.current("frontend") !== main) throw new Error("frontend should inherit main")
    main.idleCompactionMs = 12345
    if (resource.current("frontend").idleCompactionMs !== 12345) throw new Error("frontend inheritance diverged")
  `)
  assert.equal(result.code, 0, result.stderr)
})

test("configured frontend preset is an independent state", async () => {
  const result = await runWithConfig({ ...baseConfig, frontend: { enable: true, preset: "front" }, models: { front: { provider: "openai", model: "frontend-model", context_window: 64000, cache_lifetime_minutes: 5, respect_prompt_cache: true } } }, `
    const { createModelStateFactory } = await import(${JSON.stringify(modelStateUrl)})
    const resource = await createModelStateFactory({ home: process.env.NANO_HOME || "." })
    const frontend = resource.current("frontend")
    if (frontend === resource.current() || frontend.primaryModel?.id !== "frontend-model" || frontend.primaryModel?.contextWindow !== 64000) throw new Error("frontend state mismatch")
    resource.current().idleCompactionMs = 999
    if (resource.current("frontend").idleCompactionMs !== 120000) throw new Error("frontend state mutated")
  `)
  assert.equal(result.code, 0, result.stderr)
})

test("preset swaps preserve startup defaults and fast service tier", async () => {
  const result = await runWithConfig({ ...baseConfig, model: { ...baseConfig.model, enable_thinking: true, thinking_effort: "high", vision: true, respect_prompt_cache: false, compaction_strategy: "off", deep_archive: false }, models: {
    fast: { provider: "openai", model: "gpt-5.6-sol", api_key: "test-key", fast: true },
    second: { provider: "openai", model: "second-model" },
  } }, `
    const { createModelStateFactory } = await import(${JSON.stringify(modelStateUrl)})
    const resource = await createModelStateFactory({ home: process.env.NANO_HOME || "." })
    resource.applyModelSwap(resource.resolveModelSwap("fast"))
    if (!resource.getFastMode() || resource.serviceTier({ id: "gpt-5.6-sol", provider: "openai" }) !== "priority") throw new Error("fast mode mismatch")
    const second = resource.resolveModelSwap("second")
    if (!second.enableThinking || !second.vision || second.thinkingEffort !== "high" || second.respectPromptCache || second.compactionStrategy !== "off" || second.deepArchive) throw new Error("startup defaults did not carry")
  `)
  assert.equal(result.code, 0, result.stderr)
})

test("selected preset persists only its name and restores from scoped home", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-model-selection-"))
  const configValue = { ...baseConfig, models: { selected: { provider: "openai", model: "selected-v1", api_key: "preset-secret", base_url: "https://example.test/v1" } } }
  try {
    const first = await runInHome(home, configValue, `
      const { createModelStateFactory } = await import(${JSON.stringify(modelStateUrl)})
      const resource = await createModelStateFactory({ home: process.env.NANO_HOME || "." })
      await resource.persistModelSwap(resource.resolveModelSwap("selected"))
      if (resource.current().primaryApiKey !== "test-key") throw new Error("persist unexpectedly applied swap")
    `)
    assert.equal(first.code, 0, first.stderr)
    assert.equal(await fs.readFile(path.join(home, "model-selection.json"), "utf8"), "{\"preset\":\"selected\"}\n")
    configValue.models.selected.model = "selected-v2"
    const restored = await runInHome(home, configValue, `
      const { createModelStateFactory } = await import(${JSON.stringify(modelStateUrl)})
      const resource = await createModelStateFactory({ home: process.env.NANO_HOME || "." })
      if (resource.current().primaryModel?.id !== "selected-v2" || resource.current().primaryApiKey !== "preset-secret" || resource.persistedPreset() !== "selected") throw new Error("restore mismatch")
    `)
    assert.equal(restored.code, 0, restored.stderr)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("malformed selected preset fails startup", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-model-invalid-"))
  try {
    await fs.writeFile(path.join(home, "model-selection.json"), "not json", "utf8")
    const result = await runInHome(home, baseConfig, `
      const { createModelStateFactory } = await import(${JSON.stringify(modelStateUrl)})
      await createModelStateFactory({ home: process.env.NANO_HOME || "." })
    `)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /malformed persisted model selection.*invalid JSON/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("empty existing model selection fails startup", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-model-empty-selection-"))
  try {
    await fs.writeFile(path.join(home, "model-selection.json"), "", "utf8")
    const result = await runInHome(home, baseConfig, `
      const { createModelStateFactory } = await import(${JSON.stringify(modelStateUrl)})
      await createModelStateFactory({ home: process.env.NANO_HOME || "." })
    `, 15_000)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /malformed persisted model selection.*invalid JSON/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
