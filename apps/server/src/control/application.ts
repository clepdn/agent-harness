import path from "node:path"
import { fileURLToPath } from "node:url"
import { isConfigObject, type ConfigObject } from "@nano/config"
import { parseRpcAuthConfig, type RpcAuthConfig } from "@nano/protocol/rpc"
import { PluginBus, type Plugin } from "@nano/plugins"
import type { FastifyInstance } from "fastify"
import { controlHttpPlugin, CONTROL_HTTP } from "./server"
import { ControlStore } from "./db"
import {
  controlDiscoveryPlugin,
  controlOperationsPlugin,
  controlRpcAuthPlugin,
  controlStorePlugin,
  controlSupervisorPlugin,
} from "./plugins"
import { staticUiPlugin } from "./static-ui"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
const WORKER_ENTRY = path.join(REPO_ROOT, "packages", "nano-runtime", "src", "index.ts")
const WEB_DIST_DIR = path.join(REPO_ROOT, "apps", "web", "dist")

export type ControlApplicationOptions = {
  readonly config: ConfigObject
  /** Plugins may replace a built-in by id or add an independent contribution. */
  readonly plugins?: readonly Plugin[]
  readonly agentDirectory?: string
  readonly repoRoot?: string
  readonly workerEntry?: string
  readonly databasePath?: string
  readonly webDistDir?: string
  readonly controlPort: number
}

export type ControlApplication = {
  readonly bus: PluginBus
  readonly server: FastifyInstance
  close(): Promise<void>
}

type Selection = { enabled: boolean; config?: unknown }

function pluginSelection(config: ConfigObject, id: string): Selection {
  const all = isConfigObject(config.plugins) ? config.plugins : {}
  const raw = all[id]
  if (raw === undefined) return { enabled: true }
  if (!isConfigObject(raw)) throw new TypeError(`plugin selection ${id} must be an object`)
  return { enabled: raw.enabled !== false, config: raw.config }
}
/** An absent auth selection is the explicit local-open compatibility default. */
function authConfig(config: ConfigObject): RpcAuthConfig {
  const all = isConfigObject(config.plugins) ? config.plugins : {}
  const raw = all["nano.rpc-auth"]
  if (raw === undefined) return { mode: "local-open", allowedOrigins: [], permissions: [] }
  if (!isConfigObject(raw)) throw new TypeError("nano.rpc-auth selection must be an object")
  const selected = "mode" in raw ? raw : raw.config
  if (selected === undefined) return { mode: "local-open", allowedOrigins: [], permissions: [] }
  return parseRpcAuthConfig(selected)
}

const BUILTIN_IDS: Record<string, true> = {
  "nano.rpc-auth": true,
  "control.persistence": true,
  "control.discovery": true,
  "control.supervisor": true,
  "control.operations": true,
  "control.static-ui": true,
  "control.http": true,
}


export async function createControlApplication(options: ControlApplicationOptions): Promise<ControlApplication> {
  const repoRoot = options.repoRoot ?? REPO_ROOT
  const agentDirectory = path.resolve(options.agentDirectory ?? path.join(repoRoot, "agents"))
  const workerEntry = options.workerEntry ?? WORKER_ENTRY
  const webDistDir = options.webDistDir ?? WEB_DIST_DIR
  const bus = new PluginBus({ config: options.config })
  const replacements = new Map((options.plugins ?? []).map((plugin) => [plugin.id, plugin]))
  const selected = (id: string) => pluginSelection(options.config, id)

  const installBuiltin = async (id: string, fallback: Plugin, config: unknown, required = true): Promise<void> => {
    const selection = selected(id)
    const plugin = replacements.get(id) ?? fallback
    if (!selection.enabled && required) {
      throw new Error(`required control plugin ${id} cannot be disabled`)
    }
    await bus.install(plugin, selection.config === undefined ? config : selection.config, { enabled: selection.enabled })
    replacements.delete(id)
  }

  try {
    const auth = authConfig(options.config)
    await installBuiltin("nano.rpc-auth", controlRpcAuthPlugin(), auth)
    await installBuiltin("control.persistence", controlStorePlugin(new ControlStore(options.databasePath)), undefined)
    await installBuiltin("control.discovery", controlDiscoveryPlugin({ directory: agentDirectory, controlPort: options.controlPort, repoRoot, allowEmpty: true }), undefined)
    await installBuiltin("control.supervisor", controlSupervisorPlugin({ repoRoot, workerEntry }), undefined)
    await installBuiltin("control.operations", controlOperationsPlugin(), undefined)
    await installBuiltin("control.static-ui", staticUiPlugin({ directory: webDistDir, enabled: selected("control.static-ui").enabled }), undefined, false)
    await installBuiltin("control.http", controlHttpPlugin({ staticUi: selected("control.static-ui").enabled }), undefined)

    for (const plugin of options.plugins ?? []) {
      if (!replacements.has(plugin.id)) continue
      const selection = selected(plugin.id)
      if (Object.hasOwn(BUILTIN_IDS, plugin.id)) throw new Error(`failed to install replacement plugin ${plugin.id}`)
      await bus.install(plugin, selection.config, { enabled: selection.enabled })
      replacements.delete(plugin.id)
    }
    if (replacements.size > 0) throw new Error(`unknown control plugin replacement(s): ${[...replacements.keys()].join(", ")}`)
    return { bus, server: bus.get(CONTROL_HTTP), close: () => bus.close() }
  } catch (error) {
    await bus.close().catch(() => {})
    throw error
  }
}
