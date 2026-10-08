import { after } from "node:test"
import fs from "node:fs/promises"
import path from "node:path"
import { PluginBus } from "@nano/plugins"
import { config } from "./config"
import { createOpenAICompatibleModelProvider, modelProviders, registerModelProvider, type ModelProviderResolver } from "@nano/runtime/model"
import {
  bootstrapPlugin,
  clientPlugin,
  contextManagementPlugin,
  contextStrategiesPlugin,
  createPersistencePlugin,
  discordPlugin,
  imagesPlugin,
  memoryPlugin,
  modelPlugin,
  nano,
  toolFamiliesPlugin,
  toolsPlugin,
} from "@nano/runtime/plugins"
import type { RuntimeExecutionServices } from "@nano/runtime/plugins"

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
  readonly services: TestExecutionServices
  readonly providerResolver: ModelProviderResolver
  readonly bus: PluginBus
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
  const bus = new PluginBus()
  let closed = false
  await bus.install(createPersistencePlugin({ path: dbPath, home }))
  if (options.discord) {
    const gatewayEnabled = config.discord.gateway_enabled
    config.discord.gateway_enabled = false
    try { await bus.install(discordPlugin) }
    finally { config.discord.gateway_enabled = gatewayEnabled }
  }
  await bus.install(bootstrapPlugin)
  await bus.install(clientPlugin({ agentId: "test-agent", workspaceRoot: home, hashline: options.hashline ?? true }))
  await bus.install(modelPlugin)
  const model = bus.get(nano.model)
  await bus.install({
    id: `test.openai-compatible.${Math.random().toString(36).slice(2)}`,
    apply(scope) {
      registerModelProvider(scope, "openai-compatible", createOpenAICompatibleModelProvider(model.serviceTier))
    },
  })
  const providerResolver: ModelProviderResolver = () => bus.list(modelProviders)
  await bus.install(contextManagementPlugin)
  await bus.install(memoryPlugin)
  await bus.install(imagesPlugin)
  await bus.install(toolsPlugin)
  await bus.install(toolFamiliesPlugin)
  await bus.install(contextStrategiesPlugin)
  const services: TestExecutionServices = {
    providerResolver,
    model,
    bootstrap: bus.get(nano.bootstrap),
    client: bus.get(nano.client),
    discord: bus.optional(nano.discord),
    persistence: bus.get(nano.persistence),
    contextManagement: bus.get(nano.contextManagement),
    strategies: () => bus.list(nano.strategies),
    memory: bus.get(nano.memory),
    images: bus.get(nano.images),
    tools: bus.get(nano.tools),
  }
  return {
    services,
    providerResolver,
    bus,
    home,
    async close() {
      if (closed) return
      closed = true
      await bus.close()
      if (removeHome) await fs.rm(home, { recursive: true, force: true })
    },
  }
}

const defaultFixture = await createExecutionServices()
export const providerResolver = defaultFixture.providerResolver
export const executionServices = defaultFixture.services

after(() => defaultFixture.close())
