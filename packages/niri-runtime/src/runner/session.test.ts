import assert from "node:assert/strict"
import { createRequire } from "node:module"
import os from "node:os"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import test from "node:test"
import { resolveNiriHome } from "../agent-config"

const require = createRequire(import.meta.url)
const tsxLoader = require.resolve("tsx")
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
const testConfig = path.join(repoRoot, "test-config.toml")

function runChild(script: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", tsxLoader, "--input-type=module", "-e", script], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk })
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk })
    child.once("error", reject)
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`child exited with ${signal ?? code}: ${stderr || stdout}`))
      }
    })
  })
}

test("runner persistence uses NIRI_HOME when cwd is read-only", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coral-session-home-"))
  const home = path.join(root, "home")
  const readOnlyCwd = path.join(root, "installed-code")
  await fs.mkdir(home)
  await fs.mkdir(readOnlyCwd)
  await fs.chmod(readOnlyCwd, 0o555)
  t.after(async () => {
    await fs.chmod(readOnlyCwd, 0o700).catch(() => {})
    await fs.rm(root, { recursive: true, force: true })
  })

  const sessionUrl = new URL("./session.ts", import.meta.url).href
  const metricsUrl = new URL("../metrics.ts", import.meta.url).href
  await runChild(
    `
      import { saveSession, saveRestSnapshot } from ${JSON.stringify(sessionUrl)}
      import { initMetricsDb } from ${JSON.stringify(metricsUrl)}
      const messages = [{ role: "user", content: "hello", timestamp: 1 }]
      await saveSession(messages)
      await saveRestSnapshot(messages, "checkpoint")
      initMetricsDb()
    `,
    readOnlyCwd,
    { ...process.env, CORAL_CONFIG: testConfig, NIRI_HOME: home, HOME: home },
  )

  const savedSession = JSON.parse(await fs.readFile(path.join(home, "session.json"), "utf8"))
  const savedRest = JSON.parse(await fs.readFile(path.join(home, ".coral-rest-snapshot.json"), "utf8"))
  assert.equal(savedSession[0].content, "hello")
  assert.equal(savedRest.note, "checkpoint")
  assert.equal(await fs.stat(path.join(home, "metrics.db")).then(() => true).catch(() => false), true)
  assert.equal(await fs.stat(path.join(readOnlyCwd, "session.json")).then(() => true).catch(() => false), false)
  assert.equal(await fs.stat(path.join(readOnlyCwd, ".coral-rest-snapshot.json")).then(() => true).catch(() => false), false)
  assert.equal(await fs.stat(path.join(readOnlyCwd, "metrics.db")).then(() => true).catch(() => false), false)
})

test("home fallback honors managed overrides and uses OS home without them", () => {
  const osHome = os.homedir()
  assert.equal(resolveNiriHome({}, osHome), path.resolve(osHome))
  assert.equal(resolveNiriHome({ NIRI_REPO_HOME: "/nix/store/immutable-repo" }, osHome), path.resolve(osHome))
  assert.equal(resolveNiriHome({ NIRI_HOME: "   ", HOME: "\t" }, osHome), path.resolve(osHome))
  assert.equal(resolveNiriHome({ HOME: "/tmp/parent-home" }, osHome), "/tmp/parent-home")
  assert.equal(resolveNiriHome({ NIRI_HOME: "  /tmp/managed-home  ", HOME: "/tmp/parent-home" }, osHome), "/tmp/managed-home")
})
