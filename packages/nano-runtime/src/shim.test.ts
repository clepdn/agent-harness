import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const shimUrl = new URL("./shim.ts", import.meta.url).href
const tsxPath = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url))

function fixture(t: test.TestContext): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "nano-json-shim-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function runShim(home: string, script: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, NANO_SHIM_ACTIVE: "", NANO_SHIM_FAILED: "" }, encoding: "utf8",
  })
}

test("JSON shim launches a checkout, overrides config, and preserves the secrets argument", t => {
  const home = fixture(t)
  const harness = path.join(home, "checkout # with spaces")
  mkdirSync(path.join(harness, "node_modules/.bin"), { recursive: true })
  mkdirSync(path.join(harness, "packages/nano-runtime/src"), { recursive: true })
  symlinkSync(tsxPath, path.join(harness, "node_modules/.bin/tsx"))
  writeFileSync(path.join(harness, "packages/nano-runtime/src/index.ts"), `
    import assert from "node:assert/strict"
    assert.deepEqual(process.argv.slice(2), ["--config", "override.json", "--secrets", "secret.json"])
    assert.equal(process.env.NANO_SHIM_ACTIVE, "true")
    console.log("shim child verified")
  `)
  writeFileSync(path.join(home, ".harness.json"), JSON.stringify({
    shim: { enable: true, harness_path: harness, config_path: "override.json" },
  }))
  const result = runShim(home, `
    process.argv = [process.execPath, "test", "--config", "original.json", "--secrets", "secret.json"]
    const { tryShim } = await import(${JSON.stringify(shimUrl)})
    await tryShim()
    throw new Error("A successful shim must exit with its child")
  `)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /shim child verified/)
})

test("disabled JSON and legacy TOML shim files do not launch a checkout", t => {
  const home = fixture(t)
  writeFileSync(path.join(home, ".harness.toml"), '[shim]\nenable=true\nharness_path="/missing"')
  const script = `
    import assert from "node:assert/strict"
    const { tryShim, SHIM_FAILED_ENV } = await import(${JSON.stringify(shimUrl)})
    await tryShim()
    assert.equal(process.env[SHIM_FAILED_ENV], "")
  `
  assert.equal(runShim(home, script).status, 0)
  writeFileSync(path.join(home, ".harness.json"), JSON.stringify({ shim: { enable: false, harness_path: "/missing" } }))
  assert.equal(runShim(home, script).status, 0)
})
