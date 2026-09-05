import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const require = createRequire(import.meta.url)
const tsxLoader = require.resolve("tsx")
const testConfig = path.resolve(import.meta.dirname, "../../../../test-config.toml")

function runChild(script: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", tsxLoader, "--input-type=module", "-e", script], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    child.stdout.on("data", (chunk: Buffer) => { output += chunk })
    child.stderr.on("data", (chunk: Buffer) => { output += chunk })
    child.once("error", reject)
    child.once("close", (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`child exited with ${signal ?? code}: ${output}`))
    })
  })
}

test("corrupt aliases are quarantined before a new atomic map is written", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-alias-recovery-"))
  const home = path.join(root, "home")
  const memories = path.join(home, "memories")
  const aliasesFile = path.join(memories, "aliases.json")
  await fs.mkdir(memories, { recursive: true })
  await fs.writeFile(aliasesFile, "{not-json")
  t.after(async () => fs.rm(root, { recursive: true, force: true }))

  const aliasesUrl = new URL("./aliases.ts", import.meta.url).href
  await runChild(
    `
      import { listAliases, setAlias } from ${JSON.stringify(aliasesUrl)}
      const initial = await listAliases()
      if (Object.keys(initial).length !== 0) throw new Error("corrupt aliases did not fail closed")
      await setAlias("@someone", "@canonical")
    `,
    root,
    { ...process.env, NANO_CONFIG: testConfig, NANO_HOME: home, HOME: home },
  )

  assert.deepEqual(JSON.parse(await fs.readFile(aliasesFile, "utf8")), { someone: ["canonical"] })
  assert.equal((await fs.stat(aliasesFile)).mode & 0o777, 0o600)
  const files = await fs.readdir(memories)
  assert.equal(files.some((name) => name.startsWith("aliases.json.corrupt-")), true)
  assert.deepEqual(files.filter((name) => name.includes(".tmp-")), [])
})
