import path from "node:path"
import { fileURLToPath } from "node:url"
import { isConfigObject, type ConfigObject } from "@nano/config"
import { parseRpcAuthConfig, type RpcAuthConfig } from "@nano/protocol/rpc"
import { Contributions, CordisContext, getService, type Fiber, type Plugin } from "@nano/plugins"
import type { FastifyInstance } from "fastify"
import { CONTROL_HTTP } from "@nano/control-api"
import { controlHttpPlugin } from "@nano/plugin-control-http"
import { controlDiscoveryPlugin } from "@nano/plugin-control-discovery"
import { controlOperationsPlugin } from "@nano/plugin-control-operations"
import { controlStorePlugin, ControlStore } from "@nano/plugin-control-persistence"
import { controlSupervisorPlugin } from "@nano/plugin-control-supervisor"
import { staticUiPlugin } from "@nano/plugin-control-static-ui"
import { controlRpcAuthPlugin } from "@nano/plugin-control-auth"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
const WORKER_ENTRY = path.join(REPO_ROOT, "packages", "nano-runtime", "src", "index.ts")
const WEB_DIST_DIR = path.join(REPO_ROOT, "apps", "web", "dist")

export type ControlApplicationOptions = {
  readonly config: ConfigObject
  /** Native plugins replace built-ins by name or add an independent contribution. */
  readonly plugins?: readonly Plugin[]
  readonly agentDirectory?: string
  readonly repoRoot?: string
  readonly workerEntry?: string
  readonly databasePath?: string
  readonly webDistDir?: string
  readonly controlPort: number
}

export type ControlApplication = {
  readonly ctx: CordisContext
  readonly fibers: ReadonlyMap<string, Fiber>
  readonly plugins: readonly Plugin[]
  readonly server: FastifyInstance
  close(): Promise<void>
}

type Selection = { enabled: boolean; config?: unknown }
type PluginPlan = { name: string; plugin: Plugin; config?: unknown }

function pluginSelection(config: ConfigObject, name: string): Selection {
  const all = isConfigObject(config.plugins) ? config.plugins : {}
  const raw = all[name]
  if (raw === undefined) return { enabled: true }
  if (!isConfigObject(raw)) throw new TypeError(`plugin selection ${name} must be an object`)
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

function pluginName(plugin: Plugin): string {
  const name = typeof plugin === "function" ? plugin.name : plugin.name ?? plugin.apply.name
  if (!name) throw new TypeError("control plugins must have a native name")
  return name
}

export async function createControlApplication(options: ControlApplicationOptions): Promise<ControlApplication> {
  const repoRoot = options.repoRoot ?? REPO_ROOT
  const agentDirectory = path.resolve(options.agentDirectory ?? path.join(repoRoot, "agents"))
  const workerEntry = options.workerEntry ?? WORKER_ENTRY
  const webDistDir = options.webDistDir ?? WEB_DIST_DIR
  const selected = (name: string) => pluginSelection(options.config, name)
  const replacements = new Map<string, Plugin>()
  for (const plugin of options.plugins ?? []) replacements.set(pluginName(plugin), plugin)

  const authSelection = selected("nano.rpc-auth")
  const staticUiSelection = selected("control.static-ui")
  const builtins: readonly [string, Plugin, unknown, boolean][] = [
    ["nano.rpc-auth", controlRpcAuthPlugin, authConfig(options.config), true],
    ["control.persistence", controlStorePlugin(new ControlStore(options.databasePath)), undefined, true],
    ["control.discovery", controlDiscoveryPlugin({ directory: agentDirectory, controlPort: options.controlPort, repoRoot, allowEmpty: true }), undefined, true],
    ["control.supervisor", controlSupervisorPlugin({ repoRoot, workerEntry }), undefined, true],
    ["control.operations", controlOperationsPlugin(), undefined, true],
    ["control.static-ui", staticUiPlugin({ directory: webDistDir, enabled: staticUiSelection.enabled }), undefined, false],
    ["control.http", controlHttpPlugin({ staticUi: staticUiSelection.enabled }), undefined, true],
  ]
  const plan: PluginPlan[] = []
  for (const [name, fallback, defaultConfig, required] of builtins) {
    const selection = name === "nano.rpc-auth" ? authSelection : selected(name)
    const replacement = replacements.get(name)
    if (!selection.enabled) {
      if (required) throw new Error(`required control plugin ${name} cannot be disabled`)
      replacements.delete(name)
      continue
    }
    plan.push({
      name,
      plugin: replacement ?? fallback,
      config: selection.config === undefined ? defaultConfig : selection.config,
    })
    replacements.delete(name)
  }
  for (const [name, plugin] of replacements) {
    const selection = selected(name)
    if (selection.enabled) plan.push({ name, plugin, config: selection.config })
  }

  const ctx = new CordisContext()
  const fibers = new Map<string, Fiber>()
  const plugins: Plugin[] = []
  const install = async ({ name, plugin, config }: PluginPlan): Promise<void> => {
    const fiber = config === undefined ? ctx.plugin(plugin) : ctx.plugin(plugin, config)
    fibers.set(name, fiber)
    plugins.push(plugin)
    await fiber
  }

  try {
    await install({ name: "nano.contributions", plugin: Contributions })
    for (const entry of plan) await install(entry)
    return {
      ctx,
      fibers,
      plugins,
      server: getService(ctx, CONTROL_HTTP),
      close: () => ctx.fiber.dispose(),
    }
  } catch (error) {
    await ctx.fiber.dispose().catch(() => {})
    throw error
  }
}
