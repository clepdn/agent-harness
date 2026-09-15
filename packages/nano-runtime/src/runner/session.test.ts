import { SessionSnapshot } from "./session"
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

test("runner persistence uses NANO_HOME when cwd is read-only", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-session-home-"))
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
      const toolCatalog = []
      const toolCatalogFingerprint = (await import("node:crypto")).createHash("sha256").update(JSON.stringify(toolCatalog)).digest("hex")
      const discordTargets = [{ position: 1, channelId: "hidden-channel", messageId: "hidden-message", itemId: "hidden-message", content: "hello" }]
      await saveSession({ version: 1, messages, toolCatalog, toolCatalogEpoch: 1, toolCatalogFingerprint, discordTargets })
      await saveRestSnapshot(messages, "checkpoint")
      initMetricsDb()
    `,
    readOnlyCwd,
    { ...process.env, NANO_CONFIG: testConfig, NANO_HOME: home, HOME: home },
  )

  const savedSession = JSON.parse(await fs.readFile(path.join(home, "session.json"), "utf8")) as SessionSnapshot
  const savedRest = JSON.parse(await fs.readFile(path.join(home, ".nano-rest-snapshot.json"), "utf8"))
  assert.equal(savedSession.version, 1)
  assert.equal(savedSession.messages[0]?.content, "hello")
  assert.equal(savedSession.discordTargets?.[0]?.messageId, "hidden-message")
  assert.equal(savedRest.note, "checkpoint")
  assert.equal((await fs.stat(path.join(home, "session.json"))).mode & 0o777, 0o600)
  assert.equal((await fs.stat(path.join(home, ".nano-rest-snapshot.json"))).mode & 0o777, 0o600)
  assert.equal(await fs.stat(path.join(home, "metrics.db")).then(() => true).catch(() => false), true)
  assert.equal(await fs.stat(path.join(readOnlyCwd, "session.json")).then(() => true).catch(() => false), false)
  assert.equal(await fs.stat(path.join(readOnlyCwd, ".nano-rest-snapshot.json")).then(() => true).catch(() => false), false)
  assert.equal(await fs.stat(path.join(readOnlyCwd, "metrics.db")).then(() => true).catch(() => false), false)
})

test("frontend and main runners persist independent sessions and rest snapshots", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-session-lanes-"))
  const home = path.join(root, "home")
  await fs.mkdir(home)
  t.after(async () => fs.rm(root, { recursive: true, force: true }))

  const sessionUrl = new URL("./session.ts", import.meta.url).href
  await runChild(
    `
      import { createHash } from "node:crypto"
      import { loadSession, saveSession, saveRestSnapshot } from ${JSON.stringify(sessionUrl)}
      const catalog = [{ type: "function", function: { name: "wait", description: "wait", parameters: { type: "object" } } }]
      const fingerprint = createHash("sha256").update(JSON.stringify(catalog)).digest("hex")
      const snapshot = (content) => ({ version: 1, messages: [{ role: "user", content, timestamp: 1 }], toolCatalog: catalog, toolCatalogEpoch: 1, toolCatalogFingerprint: fingerprint })
      await saveSession(snapshot("main lane"))
      await saveSession(snapshot("frontend lane"), "frontend")
      await saveRestSnapshot(snapshot("main rest").messages, "main")
      await saveRestSnapshot(snapshot("frontend rest").messages, "frontend", "frontend")
      const main = await loadSession()
      const frontend = await loadSession("frontend")
      console.log(JSON.stringify({ main: main.messages[0].content, frontend: frontend.messages[0].content }))
    `,
    root,
    { ...process.env, NANO_CONFIG: testConfig, NANO_HOME: home, HOME: home },
  )

  assert.equal((JSON.parse(await fs.readFile(path.join(home, "session.json"), "utf8")) as SessionSnapshot).messages[0]?.content, "main lane")
  assert.equal((JSON.parse(await fs.readFile(path.join(home, "frontend-session.json"), "utf8")) as SessionSnapshot).messages[0]?.content, "frontend lane")
  assert.equal(await fs.stat(path.join(home, ".nano-rest-snapshot.json")).then(() => true), true)
  assert.equal(await fs.stat(path.join(home, ".nano-frontend-rest-snapshot.json")).then(() => true), true)
})

test("invalid nested session state is quarantined and restored from the last-known-good backup", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-session-recovery-"))
  const home = path.join(root, "home")
  await fs.mkdir(home)
  t.after(async () => fs.rm(root, { recursive: true, force: true }))

  const sessionUrl = new URL("./session.ts", import.meta.url).href
  await runChild(
    `
      import fs from "node:fs/promises"
      import path from "node:path"
      import { createHash } from "node:crypto"
      import { loadSession, saveSession } from ${JSON.stringify(sessionUrl)}
      const toolCatalog = []
      const toolCatalogFingerprint = createHash("sha256").update(JSON.stringify(toolCatalog)).digest("hex")
      const snapshot = (content) => ({
        version: 1,
        messages: [{ role: "user", content, timestamp: 1 }],
        toolCatalog,
        toolCatalogEpoch: 1,
        toolCatalogFingerprint,
      })
      await saveSession(snapshot("last good"))
      await saveSession(snapshot("newer"))
      await fs.writeFile(path.join(process.env.NANO_HOME, "session.json"), JSON.stringify({
        version: 1,
        messages: [{ role: "assistant", content: null, timestamp: 1 }],
        toolCatalog,
        toolCatalogEpoch: 1,
        toolCatalogFingerprint,
      }))
      const loaded = await loadSession()
      await fs.writeFile(path.join(process.env.NANO_HOME, "loaded-result.json"), JSON.stringify(loaded))
    `,
    root,
    { ...process.env, NANO_CONFIG: testConfig, NANO_HOME: home, HOME: home },
  )

  const loaded = JSON.parse(await fs.readFile(path.join(home, "loaded-result.json"), "utf8")) as SessionSnapshot | null
  assert.equal(loaded?.messages[0]?.content, "last good")
  const restored = JSON.parse(await fs.readFile(path.join(home, "session.json"), "utf8")) as SessionSnapshot
  assert.equal(restored.messages[0]?.content, "last good")
  const files = await fs.readdir(home)
  assert.equal(files.some((name) => name.startsWith("session.json.corrupt-")), true)
  assert.deepEqual(files.filter((name) => name.includes(".tmp-")), [])
})

test("fatal-loop recovery quarantines both resumable checkpoints", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-session-fatal-recovery-"))
  const home = path.join(root, "home")
  await fs.mkdir(home)
  t.after(async () => fs.rm(root, { recursive: true, force: true }))

  const sessionUrl = new URL("./session.ts", import.meta.url).href
  await runChild(
    `
      import { createHash } from "node:crypto"
      import { quarantineSession, saveSession } from ${JSON.stringify(sessionUrl)}
      const toolCatalog = []
      const toolCatalogFingerprint = createHash("sha256").update(JSON.stringify(toolCatalog)).digest("hex")
      const snapshot = (content) => ({ version: 1, messages: [{ role: "user", content, timestamp: 1 }], toolCatalog, toolCatalogEpoch: 1, toolCatalogFingerprint })
      await saveSession(snapshot("first"))
      await saveSession(snapshot("second"))
      await quarantineSession()
    `,
    root,
    { ...process.env, NANO_CONFIG: testConfig, NANO_HOME: home, HOME: home },
  )

  const files = await fs.readdir(home)
  assert.equal(files.includes("session.json"), false)
  assert.equal(files.includes("session.json.bak"), false)
  assert.equal(files.filter((name) => name.includes(".corrupt-")).length, 2)
})

test("discard archives the current session as model-readable JSON and clears resumable state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-session-discard-"))
  const home = path.join(root, "home")
  await fs.mkdir(home)
  t.after(async () => fs.rm(root, { recursive: true, force: true }))

  const sessionUrl = new URL("./session.ts", import.meta.url).href
  const memoryUrl = new URL("../agent-state-tools.ts", import.meta.url).href
  await runChild(
    `
      import fs from "node:fs/promises"
      import path from "node:path"
      import { createHash } from "node:crypto"
      import { archiveDiscardedSession, saveSession } from ${JSON.stringify(sessionUrl)}
      import { readMemory } from ${JSON.stringify(memoryUrl)}
      const toolCatalog = []
      const snapshot = {
        version: 1,
        messages: [{ role: "user", content: "keep this discarded turn", timestamp: 1 }],
        toolCatalog,
        toolCatalogEpoch: 1,
        toolCatalogFingerprint: createHash("sha256").update(JSON.stringify(toolCatalog)).digest("hex"),
      }
      await saveSession(snapshot)
      const archive = await archiveDiscardedSession(snapshot)
      const modelRead = await readMemory(archive)
      await fs.writeFile(path.join(process.env.NANO_HOME, "discard-result.json"), JSON.stringify({ archive, modelRead }))
    `,
    root,
    { ...process.env, NANO_CONFIG: testConfig, NANO_HOME: home, HOME: home },
  )

  const result = JSON.parse(await fs.readFile(path.join(home, "discard-result.json"), "utf8")) as {
    archive: string
    modelRead: string
  }
  assert.match(result.archive, /^memory:\/\/discarded-.*\.json$/)
  assert.match(result.modelRead, /keep this discarded turn/)
  assert.equal(await fs.stat(path.join(home, "session.json")).then(() => true).catch(() => false), false)
  assert.equal(await fs.stat(path.join(home, "session.json.bak")).then(() => true).catch(() => false), false)
  assert.equal(await fs.stat(path.join(home, "memories", result.archive.slice("memory://".length))).then(() => true).catch(() => false), true)
})

test("home fallback honors managed overrides and uses OS home without them", () => {
  const osHome = os.homedir()
  assert.equal(resolveNiriHome({}, osHome), path.resolve(osHome))
  assert.equal(resolveNiriHome({ NANO_REPO_HOME: "/nix/store/immutable-repo" }, osHome), path.resolve(osHome))
  assert.equal(resolveNiriHome({ NANO_HOME: "   ", HOME: "\t" }, osHome), path.resolve(osHome))
  assert.equal(resolveNiriHome({ HOME: "/tmp/parent-home" }, osHome), "/tmp/parent-home")
  assert.equal(resolveNiriHome({ NANO_HOME: "  /tmp/managed-home  ", HOME: "/tmp/parent-home" }, osHome), "/tmp/managed-home")
})
