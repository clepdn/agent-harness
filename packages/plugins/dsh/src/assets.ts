import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

/**
 * Browser half of the DeepSeek Harness web UI, served unmodified from the
 * published packages. The roster is the closure of Chat, Trajectory, the
 * workspace sidebar and the mobile shell over `dsh.client.inject`; rows whose
 * Host endpoints Nano does not implement are omitted rather than faked.
 */
const BOOTSTRAP_ID = "@deepseek-ai/dsh-client-modules"
const CLIENT_PACKAGES = [
  "@deepseek-ai/dsh-api-gateway",
  "@deepseek-ai/dsh-client-ui-theme",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-shortcuts",
  "@deepseek-ai/dsh-client-ui-layout",
  "@deepseek-ai/dsh-client-ui-renderer",
  "@deepseek-ai/dsh-client-ui-session",
  "@deepseek-ai/dsh-client-resources",
  "@deepseek-ai/dsh-client-ui-sidebar",
  "@deepseek-ai/dsh-client-ui-sidebar-right",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-conversation",
  "@deepseek-ai/dsh-client-ui-chat",
  "@deepseek-ai/dsh-client-ui-brand-official",
  "@deepseek-ai/dsh-client-ui-tool",
  "@deepseek-ai/dsh-client-ui-workspace",
  "@deepseek-ai/dsh-client-ui-input-trigger",
  "@deepseek-ai/dsh-client-ui-trajectory",
  "@canary-builds/dsh-mobile-ui",
  "@deepseek-ai/dsh-client-file-upload",
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-typert-registry",
  "@deepseek-ai/dsh-api-session-controller",
  "@deepseek-ai/dsh-api-workspace-controller",
  "@deepseek-ai/dsh-client-connection",
  BOOTSTRAP_ID,
] as const
const FRONTEND_PACKAGE = "@deepseek-ai/dsh-web-frontend"
const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/
const DIST_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|css|svg|webmanifest|png|woff2?)$/
const SOURCE_TRAILERS = /(?:\r?\n)?\/\/# source(?:Mapping)?URL=[^\r\n]*(?:\r?\n)?/g
const CONNECTION_RECOVERY = { backoffBaseMs: 500, backoffFactor: 2, backoffMaxMs: 10_000, generationReadyWarnMs: 3_000, generationReadyTimeoutMs: 15_000 }
const SHORTCUTS_CONFIG = { stopSequenceMs: 500 }
const THEME_STYLE = ":root{color-scheme:light}body{background-color:#fff;--dsh-boot-bg:#fff}@media(prefers-color-scheme:dark){:root{color-scheme:dark}body{background-color:#151517;--dsh-boot-bg:#151517}}"
const THEME_SCRIPT = `(() => {
  const preference = "system"
  const systemDark = preference === 'system' && typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'dark' || systemDark
  document.documentElement.dataset.dsThemeSource = preference
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  document.body.style.setProperty('--dsh-content-font-size', "14px")
})()`
const MODULE_QUEUE = `(()=>{
const pendingQueue=[]
window.__ModuleLoader__={
  mode:"queue",
  pendingQueue,
  load(registration){pendingQueue.push(registration)},
  create(options){
    if(this.mode!=="queue")throw new Error("client-modules: window.__ModuleLoader__.create called after module-system boot")
    const index=pendingQueue.findIndex(registration=>registration.id===${JSON.stringify(BOOTSTRAP_ID)})
    const registration=pendingQueue[index]
    if(registration===undefined)throw new Error("client-modules: HTML did not preload ${BOOTSTRAP_ID}/client.js")
    pendingQueue.splice(index,1)
    const exports=registration.factory(specifier=>{
      throw new Error('client-modules: ${BOOTSTRAP_ID}/client.js requested external "'+specifier+'" before the module system existed')
    })
    if(typeof exports!=="object"||exports===null||typeof exports.createClientModuleSystem!=="function"||typeof exports.apply!=="function"){
      throw new Error("client-modules: ${BOOTSTRAP_ID}/client.js did not export the bootstrap module face")
    }
    return exports.createClientModuleSystem(this,{id:registration.id,exports},options)
  }
}
})()`
const READY_SCRIPT = "(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()"

/** `window.__DSH_BOOT__` row (`@deepseek-ai/dsh-client-modules` WebBootEntry). */
interface BootEntry {
  id: string
  url: string
  rev: string
  inject?: string[]
  immediately?: true
  external?: string[]
}

interface BootBatch {
  phase: "bootstrap" | "application"
  url: string
  rev: string
  entries: string[]
}

interface ClientPackage {
  readonly entry: BootEntry
  readonly libDir: string
  readonly source: string
}

export interface DshAssetResponse {
  readonly body: string | Buffer
  readonly contentType: string
  readonly immutable: boolean
}

const require = createRequire(import.meta.url)

function shortHash(...parts: string[]): string {
  const hash = createHash("sha1")
  for (const part of parts) hash.update(`${Buffer.byteLength(part)}:`).update(part)
  return hash.digest("hex").slice(0, 12)
}

/** Package root of an installed dependency, whether or not it exports `./package.json`. */
function packageRoot(id: string): string {
  let directory = path.dirname(require.resolve(`${id}/client`))
  while (!existsSync(path.join(directory, "package.json")) || JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")).name !== id) {
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error(`dsh: cannot locate package root for ${id}`)
    directory = parent
  }
  return directory
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") && value.length > 0 ? value : undefined
}

function loadClientPackage(id: string): ClientPackage {
  const root = packageRoot(id)
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { dsh?: { client?: Record<string, unknown> } }
  const declaration = manifest.dsh?.client
  if (!declaration || declaration.platform !== "web") throw new Error(`dsh: ${id} does not declare a web client`)
  const clientPath = require.resolve(`${id}/client`)
  let source = readFileSync(clientPath, "utf8").replace(SOURCE_TRAILERS, "\n")
  if (!source.endsWith("\n")) source += "\n"
  const rev = shortHash(source)
  const inject = stringList(declaration.inject)
  const external = stringList(declaration.external)
  return {
    libDir: path.dirname(clientPath),
    source,
    entry: {
      id, rev, url: `plugins/??${id}/client.js&rev=${rev}`,
      ...(inject ? { inject } : {}), ...(declaration.immediately === true ? { immediately: true as const } : {}), ...(external ? { external } : {}),
    },
  }
}

/** Requested dynamic packages precede their consumers; roster order breaks ties. */
function orderByModuleGraph(entries: readonly BootEntry[]): BootEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const ordered: BootEntry[] = []
  const placed = new Set<string>()
  const open: string[] = []
  const visit = (entry: BootEntry): void => {
    if (placed.has(entry.id)) return
    if (open.includes(entry.id)) throw new Error(`dsh: client module graph cycle through ${entry.id}`)
    open.push(entry.id)
    for (const name of entry.external ?? []) {
      const dependency = byId.get(name) ?? byId.get(name.replace(/\/client$/, ""))
      if (dependency && dependency !== entry) visit(dependency)
    }
    open.pop()
    placed.add(entry.id)
    ordered.push(entry)
  }
  for (const entry of entries) visit(entry)
  return ordered
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function globalScript(name: string, value: unknown): string {
  return `<script>globalThis[${JSON.stringify(name)}] = ${JSON.stringify(value).replaceAll("<", "\\u003c")}</script>`
}

export class DshAssets {
  private readonly packages = new Map<string, ClientPackage>()
  private readonly combos = new Map<string, string>()
  private readonly distDir: string
  readonly index: string

  constructor() {
    for (const id of CLIENT_PACKAGES) this.packages.set(id, loadClientPackage(id))
    const entries = orderByModuleGraph([...this.packages.values()].map((item) => item.entry))
    const batch = (phase: BootBatch["phase"], ids: string[]): BootBatch => {
      const rev = shortHash("combo", ...ids.flatMap((id) => [id, this.packages.get(id)!.entry.rev]))
      const url = `plugins/??${ids.map((id) => `${id}/client.js`).join(",")}&rev=${rev}`
      this.combos.set(url, ids.map((id) => `${this.packages.get(id)!.source};\n`).join(""))
      return { phase, url, rev, entries: ids }
    }
    const batches = [
      batch("bootstrap", [BOOTSTRAP_ID]),
      batch("application", entries.map((entry) => entry.id).filter((id) => id !== BOOTSTRAP_ID)),
    ]
    for (const item of this.packages.values()) this.combos.set(item.entry.url, `${item.source};\n`)
    const graph = { rev: shortHash(JSON.stringify({ entries, batches })), entries, batches }

    this.distDir = path.join(path.dirname(require.resolve(`${FRONTEND_PACKAGE}/package.json`)), "dist")
    const html = readFileSync(path.join(this.distDir, "index.html"), "utf8")
    const head = [
      `<base href="./">`,
      `<style>${THEME_STYLE}</style>`,
      `<script>${MODULE_QUEUE}</script>`,
      ...batches.filter((item) => item.phase === "application").map((item) => `<link rel="preload" as="script" href="${escapeAttribute(item.url)}">`),
      ...batches.filter((item) => item.phase === "bootstrap").map((item) => `<script src="${escapeAttribute(item.url)}"></script>`),
      globalScript("__DSH_SHORTCUTS_CONFIG__", SHORTCUTS_CONFIG),
      globalScript("__DSH_CONNECTION_RECOVERY__", CONNECTION_RECOVERY),
      globalScript("__DSH_BOOT__", graph),
    ].join("")
    const body = `<script>${THEME_SCRIPT}</script><script>${READY_SCRIPT}</script>`
    this.index = html.replace(/<head(?:\s[^>]*)?>/i, (open) => `${open}${head}`).replace(/<body(?:\s[^>]*)?>/i, (open) => `${open}${body}`)
  }

  /** Serve `plugins/...` (relative to the DSH mount): revisioned combos and package-local chunks. */
  plugin(resource: string): DshAssetResponse | undefined {
    const combo = this.combos.get(`plugins/${resource}`)
    if (combo !== undefined) return { body: combo, contentType: "text/javascript; charset=utf-8", immutable: true }
    const match = /^(@[^/]+\/[^/]+|[^@/][^/]*)\/([^/?]+)(?:\?rev=[0-9a-f]+)?$/.exec(resource)
    const item = match ? this.packages.get(match[1]!) : undefined
    if (!item || !CLIENT_CHUNK.test(match![2]!)) return undefined
    const file = path.join(item.libDir, match![2]!)
    if (!existsSync(file)) return undefined
    const source = readFileSync(file, "utf8").replace(SOURCE_TRAILERS, "\n")
    return { body: source, contentType: "text/javascript; charset=utf-8", immutable: true }
  }

  /** Serve one file from the shell's `dist` (`assets/*`, icons, manifest). */
  dist(relative: string): DshAssetResponse | undefined {
    const parts = relative.split("/")
    if (parts.length > 2 || (parts.length === 2 && parts[0] !== "assets") || !DIST_FILE.test(parts.at(-1)!)) return undefined
    const file = path.join(this.distDir, ...parts)
    if (!existsSync(file)) return undefined
    const extension = path.extname(file)
    const contentType = extension === ".js" ? "text/javascript; charset=utf-8"
      : extension === ".css" ? "text/css; charset=utf-8"
        : extension === ".svg" ? "image/svg+xml"
          : extension === ".webmanifest" ? "application/manifest+json"
            : extension === ".png" ? "image/png" : "font/woff2"
    return { body: readFileSync(file), contentType, immutable: parts[0] === "assets" }
  }
}
