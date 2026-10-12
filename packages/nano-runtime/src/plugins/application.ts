import { Contributions, CordisContext } from "@nano/plugins"
import type { Fiber, Plugin } from "@nano/plugins"
import type { PluginSelection } from "@nano/runtime-api/config"
import { modelPlugin, openAICompatiblePlugin } from "@nano/plugin-model"
import { persistencePlugin } from "@nano/plugin-persistence"
import { metricsPlugin } from "@nano/plugin-metrics"
import { eventsPlugin } from "@nano/plugin-events"
import { createObservabilityPlugin } from "@nano/plugin-observability"
import { clientPlugin } from "@nano/plugin-client"
import { embeddingsPlugin } from "@nano/plugin-embeddings"
import { memoryPlugin } from "@nano/plugin-memory"
import { discordPlugin, discordCommandsPlugin } from "@nano/plugin-discord"
import { contextManagementPlugin } from "@nano/plugin-context-management"
import { contextStrategiesPlugin } from "@nano/plugin-context-strategies"
import { imagesPlugin } from "@nano/plugin-images"
import { bootstrapPlugin } from "@nano/plugin-bootstrap"
import { jobsServicePlugin } from "@nano/plugin-jobs-service"
import { subagentsPlugin } from "@nano/plugin-subagents"
import { agentChannelPlugin } from "@nano/plugin-agent-channel"
import { webSearchPlugin } from "@nano/plugin-web-search"
import { toolsPlugin } from "@nano/plugin-tools"
import { toolFamiliesPlugin } from "@nano/plugin-tool-families"
import { runnerPlugin } from "@nano/plugin-runner"
import { rpcAuthPlugin } from "@nano/plugin-rpc-auth"
import { workerOperationsPlugin, workerDiscordOperationsPlugin, workerClientOperationsPlugin, workerMetricsOperationsPlugin } from "@nano/plugin-worker-operations"
import { conversationOperationsPlugin, modelOperationsPlugin, toolsListOperationsPlugin } from "@nano/plugin-generic-operations"
import { createLifecyclePlugin } from "@nano/plugin-lifecycle"
import { createHttpPlugin } from "@nano/plugin-http"
import { dshPlugin } from "@nano/plugin-dsh"
import type { LifecycleService } from "@nano/runtime-api"

export interface NanoApplicationConfig {
  readonly plugins?: Record<string, PluginSelection | { enabled?: boolean; config?: unknown }>
  readonly [key: string]: unknown
}

export interface NanoApplicationOptions {
  readonly config?: NanoApplicationConfig
  readonly plugins?: readonly Plugin[]
  readonly disabled?: readonly string[]
  readonly replace?: readonly Plugin[]
  readonly lifecycle?: LifecycleService
  readonly listen?: { port: number; host: string }
  readonly observability?: { port: number; host?: string }
}

export interface NanoApplication {
  readonly ctx: CordisContext
  readonly fibers: ReadonlyMap<string, Fiber>
  readonly plugins: readonly Plugin[]
  close(): Promise<void>
}

export const builtInPlugins: readonly Plugin[] = [
  persistencePlugin,
  modelPlugin,
  openAICompatiblePlugin,
  metricsPlugin,
  eventsPlugin,
  bootstrapPlugin,
  clientPlugin(),
  embeddingsPlugin,
  memoryPlugin,
  discordPlugin,
  contextManagementPlugin,
  contextStrategiesPlugin,
  imagesPlugin,
  jobsServicePlugin,
  toolsPlugin,
  subagentsPlugin,
  agentChannelPlugin,
  webSearchPlugin,
  toolFamiliesPlugin,
  discordCommandsPlugin,
  runnerPlugin,
  rpcAuthPlugin,
  workerOperationsPlugin,
  workerDiscordOperationsPlugin,
  workerClientOperationsPlugin,
  workerMetricsOperationsPlugin,
  conversationOperationsPlugin,
  modelOperationsPlugin,
  toolsListOperationsPlugin,
]

function pluginName(plugin: Plugin): string {
  const name = plugin.name
  if (!name) throw new Error("Every Nano plugin must have a native name")
  return name
}

export async function createNanoApplication(options: NanoApplicationOptions = {}): Promise<NanoApplication> {
  const config = options.config ?? {}
  const replacements = new Map<string, Plugin>()
  for (const plugin of options.replace ?? []) {
    const name = pluginName(plugin)
    if (replacements.has(name)) throw new Error(`Duplicate replacement for plugin "${name}"`)
    replacements.set(name, plugin)
  }
  const definitions = [...builtInPlugins]
  if (options.lifecycle) definitions.unshift(createLifecyclePlugin(options.lifecycle))
  if (options.observability) definitions.push(createObservabilityPlugin(options.observability))
  if (options.listen) definitions.push(dshPlugin, createHttpPlugin(options.listen))
  for (const name of replacements.keys()) {
    if (!definitions.some((plugin) => pluginName(plugin) === name)) throw new Error(`Cannot replace unknown plugin "${name}"`)
  }
  const plugins = definitions.map((plugin) => replacements.get(pluginName(plugin)) ?? plugin)
  for (const extra of options.plugins ?? []) {
    const name = pluginName(extra)
    if (plugins.some((installed) => pluginName(installed) === name)) throw new Error(`Plugin "${name}" already exists; use replace`)
    plugins.push(extra)
  }
  const disabled = new Set(options.disabled ?? [])
  const ctx = new CordisContext()
  const fibers = new Map<string, Fiber>()
  const installedPlugins: Plugin[] = []
  try {
    await ctx.plugin(Contributions)
    for (const plugin of plugins) {
      const name = pluginName(plugin)
      const selection = config.plugins?.[name]
      if (disabled.has(name) || selection?.enabled === false) continue
      const raw = selection?.config ?? (name === "nano.rpc-auth" ? { mode: "open" } : undefined)
      const fiber = raw === undefined ? ctx.plugin(plugin) : ctx.plugin(plugin, raw)
      fibers.set(name, fiber)
      installedPlugins.push(plugin)
      await fiber
    }
    let closing: Promise<void> | undefined
    const close = (): Promise<void> => closing ??= (async () => {
      await fibers.get("nano.runner")?.dispose()
      await ctx.fiber.dispose()
    })()
    return { ctx, fibers, plugins: installedPlugins, close }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
