import { restSummaryFromMessages, type SessionSnapshot } from "./session"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import os from "node:os"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import test from "node:test"
import { resolveNiriHome } from "@nano/runtime-api/agent-config"

const require = createRequire(import.meta.url)
const tsxLoader = require.resolve("tsx")
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..")
const testConfig = path.join(repoRoot, "test-config.json")

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
  const metricsUrl = import.meta.resolve("@nano/plugin-metrics/store")
  await runChild(
    `
      import { createSessionStore } from ${JSON.stringify(sessionUrl)}
      import { createMetricsStore } from ${JSON.stringify(metricsUrl)}
      const store = createSessionStore(process.env.NANO_HOME)
      const messages = [{ role: "user", content: "hello", timestamp: 1 }]
      const toolCatalog = []
      const toolCatalogFingerprint = (await import("node:crypto")).createHash("sha256").update(JSON.stringify(toolCatalog)).digest("hex")
      const discordTargets = [{ position: 1, channelId: "hidden-channel", messageId: "hidden-message", itemId: "hidden-message", content: "hello" }]
      await store.saveSession({ version: 1, messages, toolCatalog, toolCatalogEpoch: 1, toolCatalogFingerprint, discordTargets, contextId: "ctx-current", parentContextId: "ctx-parent", contextForkReason: "compaction", contextConfigurationFingerprint: "config-hash", contextModelId: "test-model", contextEffortState: { initialEffort: "medium", updates: [{ beforeMessageIndex: 1, effort: "high" }] } })
      await store.saveRestSnapshot(messages, "checkpoint")
      const metrics = createMetricsStore({ home: process.env.NANO_HOME })
      metrics.close()
    `,
    readOnlyCwd,
    { ...process.env, NANO_CONFIG: testConfig, NANO_HOME: home, HOME: home },
  )

  const savedSession = JSON.parse(await fs.readFile(path.join(home, "session.json"), "utf8")) as SessionSnapshot
  const savedRest = JSON.parse(await fs.readFile(path.join(home, ".nano-rest-snapshot.json"), "utf8"))
  assert.equal(savedSession.version, 1)
  assert.equal(savedSession.messages[0]?.content, "hello")
  assert.equal(savedSession.discordTargets?.[0]?.messageId, "hidden-message")
  assert.equal(savedSession.contextId, "ctx-current")
  assert.equal(savedSession.parentContextId, "ctx-parent")
  assert.equal(savedSession.contextForkReason, "compaction")
  assert.equal(savedSession.contextConfigurationFingerprint, "config-hash")
  assert.equal(savedSession.contextModelId, "test-model")
  assert.deepEqual(savedSession.contextEffortState, { initialEffort: "medium", updates: [{ beforeMessageIndex: 1, effort: "high" }] })
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
      import { createSessionStore } from ${JSON.stringify(sessionUrl)}
      const mainStore = createSessionStore(process.env.NANO_HOME)
      const frontendStore = createSessionStore(process.env.NANO_HOME)
      const catalog = [{ type: "function", function: { name: "wait", description: "wait", parameters: { type: "object" } } }]
      const fingerprint = createHash("sha256").update(JSON.stringify(catalog)).digest("hex")
      const snapshot = (content) => ({ version: 1, messages: [{ role: "user", content, timestamp: 1 }], toolCatalog: catalog, toolCatalogEpoch: 1, toolCatalogFingerprint: fingerprint })
      await mainStore.saveSession(snapshot("main lane"))
      await frontendStore.saveSession(snapshot("frontend lane"), "frontend")
      await mainStore.saveRestSnapshot(snapshot("main rest").messages, "main")
      await frontendStore.saveRestSnapshot(snapshot("frontend rest").messages, "frontend", "frontend")
      const main = await mainStore.loadSession()
      const frontend = await frontendStore.loadSession("frontend")
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
      import { createSessionStore } from ${JSON.stringify(sessionUrl)}
      const toolCatalog = []
      const toolCatalogFingerprint = createHash("sha256").update(JSON.stringify(toolCatalog)).digest("hex")
      const snapshot = (content) => ({
        version: 1,
        messages: [{ role: "user", content, timestamp: 1 }],
        toolCatalog,
        toolCatalogEpoch: 1,
        toolCatalogFingerprint,
      })
      const store = createSessionStore(process.env.NANO_HOME)
      await store.saveSession(snapshot("last good"))
      await store.saveSession(snapshot("newer"))
      await fs.writeFile(path.join(process.env.NANO_HOME, "session.json"), JSON.stringify({
        ...snapshot("invalid timeline"),
        contextEffortState: { initialEffort: "medium", updates: [{ beforeMessageIndex: 2, effort: "high" }] },
      }))
      const loaded = await store.loadSession()
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
      import { createSessionStore } from ${JSON.stringify(sessionUrl)}
      const store = createSessionStore(process.env.NANO_HOME)
      const toolCatalog = []
      const toolCatalogFingerprint = createHash("sha256").update(JSON.stringify(toolCatalog)).digest("hex")
      const snapshot = (content) => ({ version: 1, messages: [{ role: "user", content, timestamp: 1 }], toolCatalog, toolCatalogEpoch: 1, toolCatalogFingerprint })
      await store.saveSession(snapshot("first"))
      await store.saveSession(snapshot("second"))
      await store.quarantineSession()
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
  const fixtureUrl = new URL("../../../../../tests/support/runtime-services.ts", import.meta.url).href
  await runChild(
    `
      import fs from "node:fs/promises"
      import path from "node:path"
      import { createHash } from "node:crypto"
      import { createSessionStore } from ${JSON.stringify(sessionUrl)}
      import { createExecutionServices } from ${JSON.stringify(fixtureUrl)}
      const toolCatalog = []
      const snapshot = {
        version: 1,
        messages: [{ role: "user", content: "keep this discarded turn", timestamp: 1 }],
        toolCatalog,
        toolCatalogEpoch: 1,
        toolCatalogFingerprint: createHash("sha256").update(JSON.stringify(toolCatalog)).digest("hex"),
      }
      const fixture = await createExecutionServices({ home: process.env.NANO_HOME })
      try {
        const store = createSessionStore(process.env.NANO_HOME)
        await store.saveSession(snapshot)
        const archive = await store.archiveDiscardedSession(snapshot)
        const modelRead = await fixture.services.memory.readMemory(archive)
        await fs.writeFile(path.join(process.env.NANO_HOME, "discard-result.json"), JSON.stringify({ archive, modelRead }))
      } finally {
        await fixture.close()
      }
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

test("restSummaryFromMessages returns the llm context summary", () => {
  const messages = [
    { role: "user" as const, content: "[wake]\n\nhello", timestamp: 1 },
    { role: "user" as const, content: "[context summary v1]\n[llm-summary now]\nThread: project\n- carried forward", timestamp: 2 },
    {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "recent turn" }],
      api: "openai-completions", provider: "test", model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop" as const,
      timestamp: 3,
    },
  ]
  const summary = restSummaryFromMessages(messages)
  assert.ok(summary.startsWith("[context summary v1]"))
  assert.ok(summary.includes("Thread: project"))
})
