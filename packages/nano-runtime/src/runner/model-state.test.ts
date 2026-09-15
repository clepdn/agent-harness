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

test("undefined frontend model live-inherits the mutable main model state", async () => {
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
model = "front"

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

test("configured raw frontend model id inherits connection defaults but not live state", async () => {
  const result = await runWithConfig(`${mainConfig}\n[frontend]\nenable = true\nmodel = "vendor/frontend-raw"\n`, `
    import assert from "node:assert/strict"
    const { modelState, modelStateFor } = await import(${JSON.stringify(modelStateUrl)})
    const frontend = modelStateFor("frontend")
    assert.notEqual(frontend, modelState)
    assert.equal(frontend.primaryModel?.id, "vendor/frontend-raw")
    assert.equal(frontend.primaryModel?.provider, "openai")
    assert.equal(frontend.primaryApiKey, "test-key")
  `)
  assert.equal(result.code, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"))
})

test("an explicitly empty frontend model is rejected", async () => {
  const result = await runWithConfig(`${mainConfig}\n[frontend]\nenable = true\nmodel = ""\n`, `
    await import(${JSON.stringify(modelStateUrl)})
  `)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /\[frontend\]\.model must be a non-empty model preset or model id when defined/)
})
