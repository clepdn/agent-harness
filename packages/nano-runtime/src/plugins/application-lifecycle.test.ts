import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { config as runtimeConfig } from "@nano/runtime-api/config"
import { getService, listContributions, type Plugin } from "@nano/plugins"
import { createNanoApplication, type NanoApplication, type NanoApplicationConfig } from "@nano/runtime/application"
import { createPersistenceService } from "@nano/plugin-persistence"
import { nano } from "@nano/runtime-api"
import { AssistantMessageEventStream, Context, registerModelProvider } from "@nano/runtime-api/model"
import type { AssistantMessage, Model, ModelProvider, Usage } from "@nano/runtime-api/model"

const usage: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function answer(model: Model, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "stop",
    timestamp: 0,
  }
}

function fixtureProvider(onRequest?: (messages: string) => void): ModelProvider {
  return {
    id: "application-fixture-provider",
    supports: () => true,
    complete: async (model, context) => {
      onRequest?.(JSON.stringify(context.messages))
      return answer(model, "application fixture")
    },
    stream(model, context) {
      onRequest?.(JSON.stringify(context.messages))
      const events = new AssistantMessageEventStream()
      events.push({ type: "done", reason: "stop", message: answer(model, "application fixture") })
      events.end()
      return events
    },
  }
}


function fixtureProviderPlugin(onRequest?: (messages: string) => void): Plugin {
  return {
    name: "nano.model-provider",
    inject: ["nano.contributions"],
    apply(ctx) {
      return registerModelProvider(ctx, "application-fixture", fixtureProvider(onRequest))
    },
  }
}

function applicationConfig(dbPath: string, home: string): NanoApplicationConfig {
  return { plugins: { "nano.persistence": { config: { path: dbPath, home } } } }
}

function toolCatalogFingerprint(catalog: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(catalog)).digest("hex")
}

test("the public application composes plugins and recovers a fake provider", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nano-application-lifecycle-"))
  const dbPath = path.join(root, "nano.db")
  const home = path.join(root, "home")
  const config = applicationConfig(dbPath, home)
  let app: NanoApplication | undefined
  try {
    app = await createNanoApplication({ config, replace: [fixtureProviderPlugin()] })
    const modelService = getService(app.ctx, nano.model)
    const current = modelService.current()
    const model = current.primaryModel ?? current.fallbackModel
    const context = new Context({ model, providerResolver: modelService.resolver() })
    context.append({ role: "user", content: "application lifecycle", timestamp: 0 })
    assert.deepEqual(listContributions(app.ctx, nano.modelProviders).map((entry) => entry.key), ["application-fixture"])
    const response = await context.complete()
    assert.equal(response.content[0]?.type, "text")
    if (response.content[0]?.type !== "text") throw new Error("fixture provider returned no text")
    assert.equal(response.content[0].text, "application fixture")

    const catalog = [{ type: "function" as const, function: { name: "lifecycle_tool", description: "durable fixture tool", parameters: { type: "object" } } }]
    const persistence = getService(app.ctx, nano.persistence)
    const conversationId = persistence.startConversation("lifecycle-test", "2026-10-07T00:00:00.000Z")
    persistence.logMessage(conversationId, "user", "durable lifecycle message")
    persistence.endConversation(conversationId, 3)
    await persistence.saveSession({ version: 1, messages: context.snapshot(), toolCatalog: catalog, toolCatalogEpoch: 1, toolCatalogFingerprint: toolCatalogFingerprint(catalog), contextId: context.id, parentContextId: context.parentId, contextModelId: context.model.id })
    const published = persistence.publishWorkerEvent("runner.status", { presence: "awake" })
    assert.ok(published.seq > 0)
    await app.close()
    app = undefined

    app = await createNanoApplication({ config, replace: [fixtureProviderPlugin()] })
    const restartedPersistence = getService(app.ctx, nano.persistence)
    const loaded = await restartedPersistence.loadSession()
    assert.ok(loaded)
    assert.equal(loaded.contextId, context.id)
    assert.deepEqual(loaded.toolCatalog, catalog)
    assert.equal(loaded.toolCatalogFingerprint, toolCatalogFingerprint(catalog))
    const history = await restartedPersistence.history({ limit: 20 })
    assert.ok(history.some((item) => item.content === "durable lifecycle message" && item.role === "user"))
    const bounds = restartedPersistence.workerEventBounds()
    assert.ok(bounds.latestSeq >= published.seq)
    assert.ok(bounds.oldestSeq > 0)
    const events = restartedPersistence.listWorkerEvents(published.seq - 1, 20, "after")
    assert.ok(events.some((event) => event.seq === published.seq && event.type === "runner.status"))
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("public application discards stale frontend history before waking a soul conflict", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nano-frontend-soul-startup-"))
  const dbPath = path.join(root, "nano.db")
  const home = path.join(root, "home")
  const appConfig = applicationConfig(dbPath, home)
  const mainSoulPath = path.join(home, "soul.md")
  const priorMainSoul = "Identity: shared baseline\n"
  const frontendSoul = "Identity: frontend version\n"
  const staleMarker = "OLD_FRONTEND_SESSION_RAW_HISTORY_SENTINEL"
  const staleSession = {
    version: 1 as const,
    messages: [{ role: "user" as const, content: staleMarker, timestamp: 1 }],
    toolCatalog: [],
    toolCatalogEpoch: 1,
    toolCatalogFingerprint: toolCatalogFingerprint([]),
    contextId: "stale-frontend-context",
  }
  const originalFrontendEnabled = runtimeConfig.frontend.enable
  runtimeConfig.frontend.enable = true
  let app: NanoApplication | undefined
  let resolveStartupRequest!: (messages: string) => void
  const startupRequest = new Promise<string>((resolve) => { resolveStartupRequest = resolve })
  try {
    await mkdir(home, { recursive: true })
    await writeFile(mainSoulPath, priorMainSoul, "utf8")
    app = await createNanoApplication({
      config: appConfig,
      replace: [fixtureProviderPlugin()],
      disabled: ["nano.discord"],
    })
    const bootstrap = getService(app.ctx, nano.bootstrap)
    assert.equal((await bootstrap.reconcileFrontendSoul()).soul, priorMainSoul)
    const edit = await bootstrap.writeFrontendSoul(priorMainSoul, frontendSoul)
    assert.equal(edit.conflicted, false)
    assert.match(await readFile(edit.patchPath, "utf8"), /frontend version/)
    await getService(app.ctx, nano.persistence).saveSession(staleSession, "frontend")
    assert.equal((await getService(app.ctx, nano.persistence).loadSession("frontend"))?.contextId, "stale-frontend-context")
    await app.close()
    app = undefined

    await writeFile(mainSoulPath, "Identity: main version\n", "utf8")
    app = await createNanoApplication({
      config: appConfig,
      replace: [fixtureProviderPlugin((messages) => resolveStartupRequest(messages))],
      disabled: ["nano.discord"],
    })

    const persistence = getService(app.ctx, nano.persistence)
    const reconciledSoul = await getService(app.ctx, nano.bootstrap).readFrontendSoul()
    assert.match(reconciledSoul, /^<<<<<<< main soul\.md$/m)
    assert.match(reconciledSoul, /^>>>>>>> frontend soul\.md$/m)
    assert.equal(await persistence.loadSession("frontend"), null)

    const requestedMessages = await startupRequest
    assert.match(requestedMessages, /frontend soul merge conflict/)
    assert.match(requestedMessages, /<<<<<<< main soul\.md/)
    assert.match(requestedMessages, />>>>>>> frontend soul\.md/)
    assert.doesNotMatch(requestedMessages, new RegExp(staleMarker))
    assert.equal(await persistence.loadSession("frontend"), null)
  } finally {
    await app?.close()
    runtimeConfig.frontend.enable = originalFrontendEnabled
    await rm(root, { recursive: true, force: true })
  }
})

test("two public persistence service instances preserve history, sessions, and positive event cursors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nano-persistence-restart-"))
  const dbPath = path.join(root, "nano.db")
  const home = path.join(root, "home")
  const catalog = [{
    type: "function" as const,
    function: { name: "restart_tool", description: "restart fixture tool", parameters: { type: "object" } },
  }]
  const session = {
    version: 1 as const,
    messages: [{ role: "user" as const, content: "session survives restart", timestamp: 1 }],
    toolCatalog: catalog,
    toolCatalogEpoch: 2,
    toolCatalogFingerprint: toolCatalogFingerprint(catalog),
    contextId: "restart-session-id",
  }
  const first = createPersistenceService({ path: dbPath, home, replayTailRows: 50 })
  try {
    await first.init()
    const conversationId = first.startConversation("restart-test", "2026-10-07T00:00:00.000Z")
    first.logMessage(conversationId, "user", "history survives restart")
    first.endConversation(conversationId, 4)
    await first.saveSession(session)
    const firstEvent = first.publishWorkerEvent("runner.status", { presence: "resting" })
    const firstBounds = first.workerEventBounds()
    assert.ok(firstEvent.seq > 0)
    assert.ok(firstBounds.latestSeq >= firstEvent.seq)
    first.close()

    const restarted = createPersistenceService({ path: dbPath, home, replayTailRows: 50 })
    try {
      await restarted.init()
      const loaded = await restarted.loadSession()
      assert.ok(loaded)
      assert.equal(loaded.contextId, "restart-session-id")
      assert.equal(loaded.toolCatalogEpoch, 2)
      assert.deepEqual(loaded.toolCatalog, catalog)
      const history = await restarted.listConversationHistory({ limit: 20 })
      assert.ok(history.some((item) => item.content === "history survives restart" && item.role === "user"))
      const bounds = restarted.workerEventBounds()
      assert.ok(bounds.oldestSeq > 0)
      assert.ok(bounds.latestSeq >= firstEvent.seq)
      const afterCursor = restarted.listWorkerEvents(firstEvent.seq - 1, 20, "after")
      assert.ok(afterCursor.some((event) => event.seq === firstEvent.seq && event.payload && typeof event.payload === "object"))
      const tail = restarted.listWorkerEvents(0, 1, "tail")
      assert.equal(tail.at(-1)?.seq, bounds.latestSeq)
    } finally {
      restarted.close()
    }
  } finally {
    first.close()
    await rm(root, { recursive: true, force: true })
  }
})
