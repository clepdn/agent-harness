import { PluginBus } from "@nano/plugins"
import type { Plugin } from "@nano/plugins"
import type { PluginSelection } from "../config"
import { modelPlugin, openAICompatiblePlugin } from "./model"
import { persistencePlugin } from "./persistence"
import { metricsPlugin } from "./metrics"
import { eventsPlugin } from "./events"
import { createObservabilityPlugin } from "./observability"
import { clientPlugin } from "./client"
import { embeddingsPlugin } from "./embeddings"
import { memoryPlugin } from "./memory"
import { discordPlugin, discordCommandsPlugin } from "./discord"
import { contextManagementPlugin } from "./context-management"
import { contextStrategiesPlugin } from "./context-strategies"
import { imagesPlugin } from "./images"
import { bootstrapPlugin } from "./bootstrap"
import { jobsServicePlugin } from "./jobs-service"
import { subagentsPlugin } from "./subagents"
import { agentChannelPlugin } from "./agent-channel"
import { webSearchPlugin } from "./web-search"
import { toolsPlugin } from "./tools"
import { toolFamiliesPlugin } from "./tool-families"
import { runnerPlugin } from "./runner"
import { rpcAuthPlugin } from "./rpc-auth"
import { workerOperationsPlugin, workerDiscordOperationsPlugin, workerClientOperationsPlugin, workerMetricsOperationsPlugin } from "./worker-operations"
import { conversationOperationsPlugin, modelOperationsPlugin, toolsListOperationsPlugin } from "./generic-operations"
import { nano } from "./api"
import type { LifecycleService } from "./api"
import { createHttpPlugin } from "./http"

export interface NanoApplicationConfig {
  readonly plugins?: Record<string, PluginSelection | { enabled?: boolean; config?: unknown }>
  readonly [key: string]: unknown
}
export interface NanoApplicationOptions {
  readonly config?: NanoApplicationConfig
  readonly plugins?: readonly Plugin[]
  readonly disabled?: readonly string[]
  readonly replace?: readonly Plugin[]
  readonly disposeTimeoutMs?: number
  readonly initializeTimeoutMs?: number
  readonly lifecycle?: LifecycleService
  readonly listen?: { port: number; host: string }
  readonly observability?: { port: number; host?: string }
}
export interface NanoApplication {
  readonly bus: PluginBus
  readonly plugins: readonly Plugin[]
  close(): Promise<void>
}

export const builtInPlugins: readonly Plugin[] = [
  modelPlugin,
  openAICompatiblePlugin,
  persistencePlugin,
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

export async function createNanoApplication(options: NanoApplicationOptions = {}): Promise<NanoApplication> {
  const config = options.config ?? {}
  const replacements = new Map<string, Plugin>()
  for (const plugin of options.replace ?? []) {
    if (replacements.has(plugin.id)) throw new Error(`Duplicate replacement for plugin "${plugin.id}"`)
    replacements.set(plugin.id, plugin)
  }
  const definitions = [...builtInPlugins]
  if (options.lifecycle) {
    const lifecycle = options.lifecycle
    definitions.unshift({
      id: "nano.lifecycle",
      provides: [nano.lifecycle],
      apply(scope) {
        return scope.provide(nano.lifecycle, {
          shutdown: scope.guard(() => lifecycle.shutdown()),
          restart: scope.guard((reason) => lifecycle.restart(reason)),
        })
      },
    })
  }
  if (options.observability) definitions.push(createObservabilityPlugin(options.observability))
  if (options.listen) definitions.push(createHttpPlugin(options.listen))
  for (const id of replacements.keys()) {
    if (!definitions.some((plugin) => plugin.id === id)) throw new Error(`Cannot replace unknown plugin "${id}"`)
  }
  const plugins = definitions.map((plugin) => replacements.get(plugin.id) ?? plugin)
  for (const extra of options.plugins ?? []) {
    if (plugins.some((installed) => installed.id === extra.id)) throw new Error(`Plugin "${extra.id}" already exists; use replace`)
    plugins.push(extra)
  }
  const disabled = new Set(options.disabled ?? [])
  const bus = new PluginBus({ config, disposeTimeoutMs: options.disposeTimeoutMs, initializeTimeoutMs: options.initializeTimeoutMs })
  try {
    for (const plugin of plugins) {
      const selection = config.plugins?.[plugin.id]
      const raw = selection?.config ?? (plugin.id === "nano.rpc-auth" ? { mode: "local-open" } : {})
      await bus.install(plugin, raw, { enabled: !disabled.has(plugin.id) && selection?.enabled !== false })
    }
    return { bus, plugins, close: () => bus.close() }
  } catch (error) {
    await bus.close()
    throw error
  }
}
