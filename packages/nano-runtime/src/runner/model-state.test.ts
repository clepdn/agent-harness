import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const modelStateUrl = new URL("./model-state.ts", import.meta.url).href

async function runWithConfig(configValue: Record<string, unknown>, script: string): Promise<{
  code: number | null
  stdout: string
  stderr: string
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-frontend-model-"))
  const configPath = path.join(root, "config.json")
  await fs.writeFile(configPath, JSON.stringify(configValue), "utf8")
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        env: { ...process.env, NANO_CONFIG: configPath, NANO_HOME: path.join(root, "home") },
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
      child.on("error", reject)
      child.on("close", (code) => resolve({ code, stdout, stderr }))
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function runInHome(home: string, configValue: Record<string, unknown>, script: string): Promise<{
  code: number | null
  stdout: string
  stderr: string
}> {
  await fs.mkdir(home, { recursive: true })
  const configPath = path.join(home, "config.json")
  await fs.writeFile(configPath, JSON.stringify(configValue), "utf8")
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_CONFIG: configPath, NANO_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

test("undefined frontend preset live-inherits the mutable main model state", async () => {
  const result = await runWithConfig({
    agent: {
      env: "production"
    },
    model: {
      provider: "openai",
      model: "main-model",
      api_key: "test-key",
      idle_compaction_minutes: 1
    },
    frontend: {
      enable: true
    }
  }, `
    import assert from "node:assert/strict"
    const { modelState, modelStateFor } = await import(${JSON.stringify(modelStateUrl)})
    const frontend = modelStateFor("frontend")
    assert.equal(frontend, modelState)
    modelState.idleCompactionMs = 12345
    assert.equal(modelStateFor("frontend").idleCompactionMs, 12345)
  `)
  assert.equal(result.code, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"))
})

test("configured frontend preset resolves once into independent model state", async () => {
  const result = await runWithConfig({
    agent: {
      env: "production"
    },
    model: {
      provider: "openai",
      model: "main-model",
      api_key: "test-key",
      idle_compaction_minutes: 1
    },
    frontend: {
      enable: true,
      preset: "front"
    },
    models: {
      front: {
        provider: "openai",
        model: "frontend-model",
        context_window: 64000,
        cache_lifetime_minutes: 5,
        respect_prompt_cache: true
      }
    }
  }, `
    import assert from "node:assert/strict"
    const { modelState, modelStateFor } = await import(${JSON.stringify(modelStateUrl)})
    const frontend = modelStateFor("frontend")
    assert.notEqual(frontend, modelState)
    assert.equal(frontend.primaryModel?.id, "frontend-model")
    assert.equal(frontend.primaryModel?.contextWindow, 64000)
    assert.equal(frontend.idleCompactionMs, 120000)
    modelState.idleCompactionMs = 999
    assert.equal(modelStateFor("frontend").idleCompactionMs, 120000)
  `)
  assert.equal(result.code, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"))
})

test("cache lifetime derives idle timing at startup, on the frontend, and after model swaps", async () => {
  const result = await runWithConfig({
    agent: {
      env: "production"
    },
    model: {
      provider: "openai",
      model: "main",
      api_key: "test-key",
      cache_lifetime_minutes: 30,
      respect_prompt_cache: true
    },
    frontend: {
      enable: true,
      preset: "front"
    },
    models: {
      front: {
        provider: "openai",
        model: "gpt-6-sol",
        cache_lifetime_minutes: 50,
        respect_prompt_cache: true,
        cache_warming: false
      },
      legacy: {
        provider: "openai",
        model: "legacy",
        idle_compaction_minutes: 30
      },
      "new-wins": {
        provider: "openai",
        model: "new-wins",
        idle_compaction_minutes: 80,
        cache_lifetime_minutes: 20
      },
      "no-respect": {
        provider: "openai",
        model: "no-respect",
        cache_lifetime_minutes: 30,
        respect_prompt_cache: false
      },
      warm: {
        provider: "openai",
        model: "warm",
        cache_warming: true,
        cache_lifetime_minutes: 30
      },
      off: {
        provider: "openai",
        model: "off",
        cache_lifetime_minutes: 0,
        respect_prompt_cache: true
      }
    }
  }, `
    import assert from "node:assert/strict"
    const { modelState, modelStateFor, resolveModelSwap, applyModelSwap } = await import(${JSON.stringify(modelStateUrl)})
    assert.equal(modelState.idleCompactionMs, 27 * 60000)
    assert.equal(modelStateFor("frontend").idleCompactionMs, 47 * 60000)
    for (const [name, expected] of [["legacy", 27], ["new-wins", 17], ["warm", 0], ["no-respect", 0], ["off", 0]]) {
      const selection = resolveModelSwap(name)
      applyModelSwap(selection)
      assert.equal(modelState.idleCompactionMs, expected * 60000, name)
      assert.equal(modelStateFor("frontend").idleCompactionMs, 47 * 60000)
    }
  `)
  assert.equal(result.code, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"))
})

test("an unknown frontend preset is rejected", async () => {
  const result = await runWithConfig({
    agent: {
      env: "production"
    },
    model: {
      provider: "openai",
      model: "main-model",
      api_key: "test-key",
      idle_compaction_minutes: 1
    },
    frontend: {
      enable: true,
      preset: "missing"
    }
  }, `
    const { modelStateFor } = await import(${JSON.stringify(modelStateUrl)})
    modelStateFor("frontend")
  `)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /model preset "missing" not found in \[models\]/)
})

test("an explicitly empty frontend preset is rejected", async () => {
  const result = await runWithConfig({
    agent: {
      env: "production"
    },
    model: {
      provider: "openai",
      model: "main-model",
      api_key: "test-key",
      idle_compaction_minutes: 1
    },
    frontend: {
      enable: true,
      preset: ""
    }
  }, `
    await import(${JSON.stringify(modelStateUrl)})
  `)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /\[frontend\]\.preset must be a non-empty model preset name when defined/)
})

test("the old frontend model key is rejected with a migration error", async () => {
  const result = await runWithConfig({
    agent: {
      env: "production"
    },
    model: {
      provider: "openai",
      model: "main-model",
      api_key: "test-key",
      idle_compaction_minutes: 1
    },
    frontend: {
      enable: true,
      model: "front"
    }
  }, `
    await import(${JSON.stringify(modelStateUrl)})
  `)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /\[frontend\]\.model was renamed to \[frontend\]\.preset/)
})

test("model fast defaults false and can be enabled by the selected preset", async () => {
  const defaultResult = await runWithConfig({
    agent: {
      env: "production"
    },
    model: {
      provider: "openai",
      model: "main-model",
      api_key: "test-key",
      idle_compaction_minutes: 1
    }
  }, `
    import assert from "node:assert/strict"
    const { config } = await import(${JSON.stringify(new URL("../config.ts", import.meta.url).href)})
    const { getCodexFastMode } = await import(${JSON.stringify(new URL("../codex-fast-mode.ts", import.meta.url).href)})
    assert.equal(config.model.fast, false)
    assert.equal(getCodexFastMode(), false)
  `)
  assert.equal(defaultResult.code, 0, [defaultResult.stdout, defaultResult.stderr].filter(Boolean).join("\n"))

  const configuredResult = await runWithConfig({
    agent: {
      env: "production"
    },
    models: {
      gpt: {
        provider: "openai",
        model: "gpt-5.6-sol",
        api_key: "test-key",
        fast: true
      }
    },
    model: {
      preset: "gpt"
    }
  }, `
    import assert from "node:assert/strict"
    const { config } = await import(${JSON.stringify(new URL("../config.ts", import.meta.url).href)})
    const { codexServiceTier, getCodexFastMode } = await import(${JSON.stringify(new URL("../codex-fast-mode.ts", import.meta.url).href)})
    assert.equal(config.model.fast, true)
    assert.equal(getCodexFastMode(), true)
    assert.equal(codexServiceTier({ id: "gpt-5.6-sol", provider: "openai" }), "priority")
  `)
  assert.equal(configuredResult.code, 0, [configuredResult.stdout, configuredResult.stderr].filter(Boolean).join("\n"))
})

test("runtime model swaps apply each preset's fast value", async () => {
  const result = await runWithConfig({
    agent: {
      env: "production"
    },
    model: {
      provider: "openai",
      model: "main-model",
      api_key: "test-key",
      idle_compaction_minutes: 1,
      respect_prompt_cache: false
    },
    models: {
      fast: {
        provider: "openai",
        model: "gpt-5.6-sol",
        api_key: "test-key",
        fast: true
      },
      default: {
        provider: "openai",
        model: "gpt-5.6-terra",
        api_key: "test-key"
      }
    }
  }, `
    import assert from "node:assert/strict"
    const { applyModelSwap, resolveModelSwap, modelState } = await import(${JSON.stringify(modelStateUrl)})
    const { getCodexFastMode } = await import(${JSON.stringify(new URL("../codex-fast-mode.ts", import.meta.url).href)})

    const fast = resolveModelSwap("fast")
    applyModelSwap(fast)
    assert.equal(getCodexFastMode(), true)

    const defaultTier = resolveModelSwap("default")
    applyModelSwap(defaultTier)
    assert.equal(getCodexFastMode(), false)
    modelState.useFallback = true
    applyModelSwap(fast)
    assert.equal(modelState.useFallback, false)
  `)
  assert.equal(result.code, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"))
})

test("cache warming is opt-in and preset settings follow frontend resolution and model swaps", async () => {
  const defaults = await runWithConfig({
    agent: {
      env: "production"
    },
    model: {
      provider: "openai",
      model: "main-model",
      api_key: "test-key"
    }
  }, `
    import assert from "node:assert/strict"
    const { modelState } = await import(${JSON.stringify(modelStateUrl)})
    assert.equal(modelState.cacheWarming, false)
    assert.equal(modelState.cacheWarmingDurationMs, 0)
    assert.equal(modelState.cacheWarmingMode, "completion")
    assert.equal(modelState.cacheLifetimeMs, 1800000)
  `)
  assert.equal(defaults.code, 0, defaults.stderr)
  const result = await runWithConfig({
    agent: {
      env: "production"
    },
    model: {
      provider: "openai",
      model: "main-model",
      api_key: "test-key",
      idle_compaction_minutes: 1,
      respect_prompt_cache: false
    },
    frontend: {
      enable: true,
      preset: "warm"
    },
    models: {
      warm: {
        provider: "openai",
        model: "gpt-6-sol",
        api_key: "test-key",
        cache_warming: true,
        cache_warming_minutes: 315,
        cache_warming_mode: "prewarm",
        cache_lifetime_minutes: 20
      },
      off: {
        provider: "openai",
        model: "gpt-6-luna",
        api_key: "test-key",
        cache_warming: false,
        cache_lifetime_minutes: 0
      },
      unconfigured: {
        provider: "openai",
        model: "claude",
        api_key: "test-key"
      }
    }
  }, `
    import assert from "node:assert/strict"
    const { modelState, modelStateFor, resolveModelSwap, applyModelSwap } = await import(${JSON.stringify(modelStateUrl)})
    const frontend = modelStateFor("frontend")
    assert.equal(frontend.cacheWarming, true)

    assert.equal(frontend.cacheWarmingDurationMs, 18900000)
    assert.equal(frontend.cacheWarmingMode, "prewarm")
    assert.equal(frontend.cacheLifetimeMs, 1200000)
    const warm = resolveModelSwap("warm")
    applyModelSwap(warm)
    assert.equal(modelState.cacheWarming, true)
    assert.equal(modelState.cacheWarmingDurationMs, 18900000)
    assert.equal(modelState.cacheWarmingMode, "prewarm")
    assert.equal(modelState.cacheLifetimeMs, 1200000)
    const unconfigured = resolveModelSwap("unconfigured")
    assert.equal(unconfigured.cacheWarming, false, "warming must not leak into other providers on a swap")
    assert.equal(unconfigured.cacheWarmingDurationMs, 0)
    assert.equal(unconfigured.cacheWarmingMode, "completion")
    const off = resolveModelSwap("off")
    applyModelSwap(off)
    assert.equal(modelState.cacheWarming, false)
    assert.equal(modelState.cacheWarmingDurationMs, 0)
    assert.equal(modelState.cacheLifetimeMs, 0)
    assert.equal(modelStateFor("frontend").cacheWarming, true)
  `)
  assert.equal(result.code, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"))
})
test("model selection persists only its preset name and re-resolves current config at startup", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-model-selection-"))
  const configValue = {
    agent: { env: "production" },
    model: { provider: "openai", model: "main-model", api_key: "main-secret" },
    models: {
      selected: { provider: "openai", model: "selected-v1", api_key: "preset-secret", base_url: "https://example.test/v1" },
    },
  }
  try {
    const writeResult = await runInHome(home, configValue, `
      const { resolveModelSwap, persistModelSwap, modelState } = await import(${JSON.stringify(modelStateUrl)})
      const selection = resolveModelSwap("selected")
      await persistModelSwap(selection)
      if (modelState.primaryApiKey !== "main-secret") throw new Error("persist must not apply selection")
    `)
    assert.equal(writeResult.code, 0, [writeResult.stdout, writeResult.stderr].filter(Boolean).join("\n"))
    const persistedPath = path.join(home, "model-selection.json")
    const persisted = await fs.readFile(persistedPath, "utf8")
    assert.equal(persisted, '{"preset":"selected"}\n')
    assert.doesNotMatch(persisted, /secret|selected-v1|example\.test/)

    configValue.models.selected.model = "selected-v2"
    const restoreResult = await runInHome(home, configValue, `
      const { modelState, persistedModelPreset } = await import(${JSON.stringify(modelStateUrl)})
      if (modelState.primaryModel?.id !== "selected-v2") throw new Error(String(modelState.primaryModel?.id))
      if (modelState.primaryApiKey !== "preset-secret") throw new Error("preset key was not re-resolved")
      if (modelState.useFallback) throw new Error("restored preset is not active")
      console.log(persistedModelPreset)
    `)
    assert.equal(restoreResult.code, 0, [restoreResult.stdout, restoreResult.stderr].filter(Boolean).join("\n"))
    assert.match(restoreResult.stdout, /selected/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("malformed or removed persisted model selections fail startup instead of falling back", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-invalid-model-selection-"))
  const configValue = {
    agent: { env: "production" },
    model: { provider: "openai", model: "main-model", api_key: "test-key" },
    models: { selected: { provider: "openai", model: "selected-model", api_key: "test-key" } },
  }
  try {
    await fs.mkdir(home, { recursive: true })
    const normalStartup = await runInHome(home, configValue, `await import(${JSON.stringify(modelStateUrl)})`)
    assert.equal(normalStartup.code, 0, normalStartup.stderr)

    const selectionPath = path.join(home, "model-selection.json")
    await fs.writeFile(selectionPath, "not json", "utf8")
    const malformedStartup = await runInHome(home, configValue, `await import(${JSON.stringify(modelStateUrl)})`)
    assert.notEqual(malformedStartup.code, 0)
    assert.match(malformedStartup.stderr, /malformed persisted model selection.*invalid JSON/)

    await fs.writeFile(selectionPath, '{"preset":"removed"}\n', "utf8")
    const removedStartup = await runInHome(home, configValue, `await import(${JSON.stringify(modelStateUrl)})`)
    assert.notEqual(removedStartup.code, 0)
    assert.match(removedStartup.stderr, /cannot restore persisted model preset "removed": model preset "removed" not found/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("preset omissions resolve against startup defaults across later swaps and restart", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nano-model-defaults-"))
  const configValue = {
    agent: { env: "production" },
    model: {
      provider: "openai", model: "main-model", api_key: "main-secret",
      enable_thinking: true, thinking_effort: "high", vision: true,
      respect_prompt_cache: false, compaction_strategy: "off", deep_archive: false,
    },
    models: {
      first: { provider: "openai", model: "first-model", enable_thinking: false, vision: false, thinking_effort: "low" },
      second: { provider: "openai", model: "second-model" },
    },
  }
  try {
    const firstRun = await runInHome(home, configValue, `
      const { resolveModelSwap, applyModelSwap, persistModelSwap } = await import(${JSON.stringify(modelStateUrl)})
      applyModelSwap(resolveModelSwap("first"))
      const second = resolveModelSwap("second")
      if (second.enableThinking !== true || second.vision !== true || second.thinkingEffort !== "high") {
        throw new Error(JSON.stringify({ thinking: second.enableThinking, vision: second.vision, effort: second.thinkingEffort }))
      }
      if (second.respectPromptCache !== false || second.compactionStrategy !== "off" || second.deepArchive !== false) {
        throw new Error("omitted settings did not use configured defaults")
      }
      await persistModelSwap(second)
    `)
    assert.equal(firstRun.code, 0, [firstRun.stdout, firstRun.stderr].filter(Boolean).join("\n"))
    const restarted = await runInHome(home, configValue, `
      const { modelState } = await import(${JSON.stringify(modelStateUrl)})
      if (modelState.primaryModel?.id !== "second-model" || !modelState.enableThinking || !modelState.primaryVision) throw new Error("restored model settings diverged")
      if (modelState.thinkingEffort !== "high" || modelState.respectPromptCache || modelState.compactionStrategy !== "off" || modelState.deepArchive) throw new Error("restored settings diverged")
    `)
    assert.equal(restarted.code, 0, [restarted.stdout, restarted.stderr].filter(Boolean).join("\n"))
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
