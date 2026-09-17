import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const modelStateUrl = new URL("./model-state.ts", import.meta.url).href

async function runWithConfig(configText: string, script: string): Promise<{
  code: number | null
  stdout: string
  stderr: string
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-frontend-model-"))
  const configPath = path.join(root, "config.toml")
  await fs.writeFile(configPath, configText, "utf8")
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

const mainConfig = `
[agent]
env = "production"

[model]
provider = "openai"
model = "main-model"
api_key = "test-key"
idle_compaction_minutes = 1
`

test("undefined frontend preset live-inherits the mutable main model state", async () => {
  const result = await runWithConfig(`${mainConfig}\n[frontend]\nenable = true\n`, `
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
  const result = await runWithConfig(`${mainConfig}
[frontend]
enable = true
preset = "front"

[models.front]
provider = "openai"
model = "frontend-model"
context_window = 64000
idle_compaction_minutes = 2
`, `
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

test("an unknown frontend preset is rejected", async () => {
  const result = await runWithConfig(`${mainConfig}\n[frontend]\nenable = true\npreset = "missing"\n`, `
    const { modelStateFor } = await import(${JSON.stringify(modelStateUrl)})
    modelStateFor("frontend")
  `)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /model preset "missing" not found in \[models\]/)
})

test("an explicitly empty frontend preset is rejected", async () => {
  const result = await runWithConfig(`${mainConfig}\n[frontend]\nenable = true\npreset = ""\n`, `
    await import(${JSON.stringify(modelStateUrl)})
  `)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /\[frontend\]\.preset must be a non-empty model preset name when defined/)
})

test("the old frontend model key is rejected with a migration error", async () => {
  const result = await runWithConfig(`${mainConfig}\n[frontend]\nenable = true\nmodel = "front"\n`, `
    await import(${JSON.stringify(modelStateUrl)})
  `)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /\[frontend\]\.model was renamed to \[frontend\]\.preset/)
})

test("model fast defaults false and can be enabled by the selected preset", async () => {
  const defaultResult = await runWithConfig(mainConfig, `
    import assert from "node:assert/strict"
    const { config } = await import(${JSON.stringify(new URL("../config.ts", import.meta.url).href)})
    const { getCodexFastMode } = await import(${JSON.stringify(new URL("../codex-fast-mode.ts", import.meta.url).href)})
    assert.equal(config.model.fast, false)
    assert.equal(getCodexFastMode(), false)
  `)
  assert.equal(defaultResult.code, 0, [defaultResult.stdout, defaultResult.stderr].filter(Boolean).join("\n"))

  const configuredResult = await runWithConfig(`
[agent]
env = "production"

[models.gpt]
provider = "openai"
model = "gpt-5.6-sol"
api_key = "test-key"
fast = true

[model]
preset = "gpt"
`, `
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
  const result = await runWithConfig(`${mainConfig}
respect_prompt_cache = false

[models.fast]
provider = "openai"
model = "gpt-5.6-sol"
api_key = "test-key"
fast = true

[models.default]
provider = "openai"
model = "gpt-5.6-terra"
api_key = "test-key"
`, `
    import assert from "node:assert/strict"
    const { applyModelSwap, evaluateModelSwap } = await import(${JSON.stringify(modelStateUrl)})
    const { getCodexFastMode } = await import(${JSON.stringify(new URL("../codex-fast-mode.ts", import.meta.url).href)})

    const fast = evaluateModelSwap("fast", 0)
    assert.equal(fast.action, "swap")
    if (fast.action === "swap") applyModelSwap(fast)
    assert.equal(getCodexFastMode(), true)

    const defaultTier = evaluateModelSwap("default", 0)
    assert.equal(defaultTier.action, "swap")
    if (defaultTier.action === "swap") applyModelSwap(defaultTier)
    assert.equal(getCodexFastMode(), false)
  `)
  assert.equal(result.code, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"))
})
