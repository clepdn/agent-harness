import { after } from "node:test"
import fs from "node:fs/promises"
import path from "node:path"
import { CordisContext, Contributions, getService, findService, listContributions, type Fiber, type Plugin } from "@nano/plugins"
import { config } from "./config"
import { createOpenAICompatibleModelProvider, modelProviders, registerModelProvider, type ModelProviderResolver } from "@nano/runtime-api/model"
import { nano, type RuntimeExecutionServices } from "@nano/runtime-api"
import { bootstrapPlugin } from "@nano/plugin-bootstrap"
import { clientPlugin } from "@nano/plugin-client"
import { contextManagementPlugin } from "@nano/plugin-context-management"
import { contextStrategiesPlugin } from "@nano/plugin-context-strategies"
import { createPersistencePlugin } from "@nano/plugin-persistence"
import { discordPlugin } from "@nano/plugin-discord"
import { imagesPlugin } from "@nano/plugin-images"
import { memoryPlugin } from "@nano/plugin-memory"
import { modelPlugin } from "@nano/plugin-model"
import { toolFamiliesPlugin } from "@nano/plugin-tool-families"
import { toolsPlugin } from "@nano/plugin-tools"

export interface TestExecutionServices extends RuntimeExecutionServices {
  readonly model: NonNullable<RuntimeExecutionServices["model"]>
  readonly bootstrap: NonNullable<RuntimeExecutionServices["bootstrap"]>
  readonly client: NonNullable<RuntimeExecutionServices["client"]>
  readonly persistence: NonNullable<RuntimeExecutionServices["persistence"]>
  readonly contextManagement: NonNullable<RuntimeExecutionServices["contextManagement"]>
  readonly memory: NonNullable<RuntimeExecutionServices["memory"]>
  readonly images: NonNullable<RuntimeExecutionServices["images"]>
  readonly tools: NonNullable<RuntimeExecutionServices["tools"]>
}

export interface TestExecutionFixture {
  readonly ctx: CordisContext
  readonly fibers: ReadonlyMap<string, Fiber>
  readonly plugins: readonly Plugin[]
  readonly services: TestExecutionServices
  readonly providerResolver: ModelProviderResolver
  readonly home: string
  close(): Promise<void>
}

export interface TestExecutionFixtureOptions {
  readonly home?: string
  readonly dbPath?: string
  readonly removeHomeOnClose?: boolean
  readonly discord?: boolean
  readonly hashline?: boolean
}

export async function createExecutionServices(options: TestExecutionFixtureOptions = {}): Promise<TestExecutionFixture> {
  const configuredHome = options.home ?? process.env.NANO_HOME?.trim()
  const ownsHome = configuredHome === undefined
  const home = configuredHome ?? await fs.mkdtemp("/tmp/nano-test-provider-")
  const dbPath = options.dbPath ?? path.join(home, "nano.db")
  const removeHome = options.removeHomeOnClose ?? ownsHome
  const ctx = new CordisContext()
  await ctx.plugin(Contributions)
  const fibers = new Map<string, Fiber>()
  const plugins: Plugin[] = []
  const install = async (plugin: Plugin, name = plugin.name ?? `plugin-${plugins.length}`) => {
    plugins.push(plugin)
    const fiber = await ctx.plugin(plugin, {})
    fibers.set(name, fiber)
    return fiber
  }
  let closed = false
  await install(createPersistencePlugin({ path: dbPath, home }), "nano.persistence")
  if (options.discord) {
    const gatewayEnabled = config.discord.gateway_enabled
    config.discord.gateway_enabled = false
    try { await install(discordPlugin, "nano.discord") }
    finally { config.discord.gateway_enabled = gatewayEnabled }
  }
  await install(bootstrapPlugin, "nano.bootstrap")
  await install(clientPlugin({ agentId: "test-agent", workspaceRoot: home, hashline: options.hashline ?? true }), "nano.client")
  await install(modelPlugin, "nano.model")
  const model = getService(ctx, nano.model)
  const providerPlugin: Plugin = {
    name: "test.openai-compatible",
    inject: ["nano.model", "nano.contributions"],
    apply(ctx) {
      registerModelProvider(ctx, "openai-compatible", createOpenAICompatibleModelProvider(model.serviceTier))
    },
  }
  await install(providerPlugin, "test.openai-compatible")
  const providerResolver: ModelProviderResolver = () => listContributions(ctx, modelProviders)
  await install(contextManagementPlugin, "nano.context-management")
  await install(memoryPlugin, "nano.memory")
  await install(imagesPlugin, "nano.images")
  await install(toolsPlugin, "nano.tools")
  await install(toolFamiliesPlugin, "nano.tool-families")
  await install(contextStrategiesPlugin, "nano.context-strategies")
  const services: TestExecutionServices = {
    providerResolver,
    model,
    bootstrap: getService(ctx, nano.bootstrap),
    client: getService(ctx, nano.client),
    discord: findService(ctx, nano.discord),
    persistence: getService(ctx, nano.persistence),
    contextManagement: getService(ctx, nano.contextManagement),
    strategies: () => listContributions(ctx, nano.strategies),
    memory: getService(ctx, nano.memory),
    images: getService(ctx, nano.images),
    tools: getService(ctx, nano.tools),
  }
  return {
    ctx,
    fibers,
    plugins,
    services,
    providerResolver,
    home,
    async close() {
      if (closed) return
      closed = true
      await ctx.fiber.dispose()
      if (removeHome) await fs.rm(home, { recursive: true, force: true })
    },
  }
}

const defaultFixture = await createExecutionServices()
export const providerResolver = defaultFixture.providerResolver
export const executionServices = defaultFixture.services

after(() => defaultFixture.close())
