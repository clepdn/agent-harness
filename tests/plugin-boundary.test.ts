import assert from "node:assert/strict"
import { createRequire, isBuiltin } from "node:module"
import os from "node:os"
import path from "node:path"
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"
import ts from "typescript"
import { Context as NativeCordisContext } from "@deepseek-ai/cordis"
import type { Plugin, ServiceToken } from "@nano/plugins"
import * as runtimeApi from "@nano/runtime-api"
import { contextStrategiesPlugin } from "@nano/plugin-context-strategies"

type RuntimeApiExports = typeof runtimeApi

interface PackageManifest {
  name: string
  exports?: string | Record<string, unknown>
  files?: string[]
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

interface WorkspacePackage {
  root: string
  manifest: PackageManifest
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const publicApiDirectories = [
  "packages/nano-plugins",
  "packages/nano-protocol",
  "packages/nano-runtime-api",
  "packages/nano-control-api",
  "packages/nano-web-api",
  "packages/harness-protocol",
  "packages/harness-core",
  "packages/harness-server",
  "packages/harness-client-node",
]
const packageEntries = new Map<string, WorkspacePackage>()


function workspacePackage(root: string): WorkspacePackage {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageManifest
  assert.ok(manifest.name, `Package at ${root} has no name`)
  return { root: realpathSync(root), manifest }
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function sourceFiles(root: string): string[] {
  const sourceRoot = path.join(root, "src")
  if (!existsSync(sourceRoot)) return []
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory()) {
        if (!["test", "tests", "__tests__", "fixtures"].includes(entry.name)) visit(path.join(directory, entry.name))
        continue
      }
      if (!entry.isFile() || !/\.(?:[cm]?tsx?|mts|cts)$/.test(entry.name)) continue
      if (/\.(?:test|spec)\.(?:[cm]?tsx?|mts|cts)$/.test(entry.name)) continue
      if (["test-model-provider.ts", "test-helpers.ts"].includes(entry.name)) continue
      files.push(path.join(directory, entry.name))
    }
  }
  visit(sourceRoot)
  return files
}

function moduleSpecifiers(fileName: string): Array<{ specifier: string; line: number }> {
  const text = readFileSync(fileName, "utf8")
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const result: Array<{ specifier: string; line: number }> = []
  const add = (node: ts.Node, value: ts.Expression | ts.TypeNode | undefined): void => {
    if (value && ts.isStringLiteralLike(value)) {
      result.push({ specifier: value.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 })
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node, node.moduleSpecifier)
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node, node.argument.literal)
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression)
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const first = node.arguments[0]
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const commonJsRequire = ts.isIdentifier(node.expression) && node.expression.text === "require"
      if (dynamicImport || commonJsRequire) {
        assert.ok(first && ts.isStringLiteralLike(first), `${fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} uses a non-literal ${dynamicImport ? "dynamic import" : "require"}; package boundaries must be statically resolvable`)
        add(node, first)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

function packageNameFromSpecifier(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/")
  return specifier.split("/")[0] ?? specifier
}

function declaredDependencies(manifest: PackageManifest): Set<string> {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])
}

function exportKeys(exportsField: PackageManifest["exports"]): Array<[string, unknown]> {
  if (typeof exportsField === "string") return [[".", exportsField]]
  assert.ok(exportsField && typeof exportsField === "object", "Public packages must declare an exports map")
  const entries = Object.entries(exportsField).sort(([left], [right]) => left.localeCompare(right))
  assert.ok(entries.length > 0, "Public packages must expose at least one entry")
  for (const [key] of entries) assert.ok(!key.includes("*"), `Wildcard package export ${key} is not an explicit public boundary`)
  return entries
}

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(exportTargets)
  if (value && typeof value === "object") return Object.values(value).flatMap(exportTargets)
  return []
}

function resolvePublicSpecifier(specifier: string): string {
  const resolved = import.meta.resolve(specifier)
  assert.ok(resolved.startsWith("file:"), `${specifier} did not resolve to a local package file: ${resolved}`)
  return realpathSync(fileURLToPath(resolved))
}

function publicPackageImportGraph(packages: WorkspacePackage[], pluginPackages: WorkspacePackage[], appPackageNames: Set<string>): void {
  const packagesByName = new Map([...packageEntries.values()].map(entry => [entry.manifest.name, entry]))
  const forbiddenHostNames = new Set(["@nano/runtime", ...appPackageNames])
  const pluginNames = new Set(pluginPackages.map(entry => entry.manifest.name))

  for (const entry of packages) {
    const dependencies = declaredDependencies(entry.manifest)
    const isPluginImplementation = pluginNames.has(entry.manifest.name)
    for (const dependency of dependencies) {
      assert.ok(!forbiddenHostNames.has(dependency), `${entry.manifest.name} declares host/application dependency ${dependency}`)
      if (!isPluginImplementation) assert.ok(!pluginNames.has(dependency), `${entry.manifest.name} declares plugin implementation dependency ${dependency}`)
    }

    for (const fileName of sourceFiles(entry.root)) {
      for (const { specifier, line } of moduleSpecifiers(fileName)) {
        const location = `${path.relative(repoRoot, fileName)}:${line}`
        if (specifier.startsWith(".") || specifier.startsWith("#")) {
          const resolved = ts.resolveModuleName(specifier, fileName, {
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            target: ts.ScriptTarget.ES2022,
            resolveJsonModule: true,
            customConditions: ["development"],
          }, ts.sys).resolvedModule?.resolvedFileName
          assert.ok(resolved, `${location} has an unresolved local import ${specifier}`)
          const normalized = realpathSync(resolved)
          assert.ok(within(entry.root, normalized), `${location} escapes ${entry.manifest.name} through ${specifier} -> ${path.relative(repoRoot, normalized)}`)
          continue
        }
        if (isBuiltin(specifier)) continue

        const dependencyName = packageNameFromSpecifier(specifier)
        assert.ok(dependencies.has(dependencyName), `${location} imports ${specifier}, but ${dependencyName} is not declared in dependencies or peerDependencies`)
        assert.ok(!forbiddenHostNames.has(dependencyName), `${location} imports forbidden runtime/application host ${specifier}`)
        if (!isPluginImplementation) assert.ok(!pluginNames.has(dependencyName), `${location} imports plugin implementation ${specifier}; public SDKs cannot depend on plugin implementations`)

        let resolved: string
        try {
          resolved = resolvePublicSpecifier(specifier)
        } catch (error) {
          assert.fail(`${location} imports non-public or unresolved package entry ${specifier}: ${String(error)}`)
        }
        const owner = packagesByName.get(dependencyName)
        if (owner) assert.ok(within(owner.root, resolved), `${location} resolves ${specifier} outside ${dependencyName}: ${resolved}`)
      }
    }
  }
}

function prepareWorkspaceInventory(): { plugins: WorkspacePackage[]; publicApis: WorkspacePackage[]; appNames: Set<string> } {
  const packageDirectories = readdirSync(path.join(repoRoot, "packages"), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(path.join(repoRoot, "packages", entry.name, "package.json")))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => path.join(repoRoot, "packages", entry.name))
  for (const root of packageDirectories) {
    assert.ok(readdirSync(root).includes("package.json"), `${path.relative(repoRoot, root)} has no package manifest`)
    packageEntries.set(path.resolve(root), workspacePackage(root))
  }

  const pluginDirectories = readdirSync(path.join(repoRoot, "packages/plugins"), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => path.join(repoRoot, "packages/plugins", entry.name))
  assert.ok(pluginDirectories.length > 0, "The workspace must contain built-in plugin packages")
  const plugins = pluginDirectories.map(root => {
    const manifestPath = path.join(root, "package.json")
    assert.ok(readdirSync(root).includes("package.json"), `Plugin directory ${path.relative(repoRoot, root)} has no package manifest`)
    const entry = workspacePackage(root)
    assert.ok(entry.manifest.name.startsWith("@nano/plugin-"), `${manifestPath} is not named as a plugin package`)
    assert.ok(entry.manifest.files?.includes("src"), `${entry.manifest.name} must package its source directory`)
    assert.ok(sourceFiles(entry.root).length > 0, `${entry.manifest.name} has no production TypeScript source`)
    packageEntries.set(path.resolve(root), entry)
    return entry
  })
  const publicApis = publicApiDirectories.map(directory => {
    const entry = packageEntries.get(path.resolve(repoRoot, directory))
    assert.ok(entry, `Public package inventory is missing ${directory}`)
    return entry
  })
  const appNames = new Set(readdirSync(path.join(repoRoot, "apps"), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => (JSON.parse(readFileSync(path.join(repoRoot, "apps", entry.name, "package.json"), "utf8")) as PackageManifest).name))
  return { plugins, publicApis, appNames }
}

const inventory = prepareWorkspaceInventory()

function assertExportsResolve(entry: WorkspacePackage): void {
  const entries = exportKeys(entry.manifest.exports)
  const targets = entries.flatMap(([, value]) => exportTargets(value))
  assert.ok(targets.length > 0, `${entry.manifest.name} has no concrete export targets`)
  for (const target of targets) {
    const resolvedTarget = path.resolve(entry.root, target)
    assert.ok(target.startsWith("./") && within(entry.root, resolvedTarget), `${entry.manifest.name} export target must stay package-local: ${target}`)
    assert.ok(existsSync(resolvedTarget), `${entry.manifest.name} export target does not exist: ${target}`)
    assert.ok(within(entry.root, realpathSync(resolvedTarget)), `${entry.manifest.name} export target resolves outside its package: ${target}`)
  }
  for (const [key] of entries) {
    const specifier = key === "." ? entry.manifest.name : `${entry.manifest.name}/${key.startsWith("./") ? key.slice(2) : key}`
    const resolved = resolvePublicSpecifier(specifier)
    assert.ok(within(entry.root, resolved), `${specifier} resolves outside its package: ${resolved}`)
  }
  const privateSourceEntry = `${entry.manifest.name}/src/index`
  assert.throws(
    () => import.meta.resolve(privateSourceEntry),
    error => error instanceof Error && (error as NodeJS.ErrnoException).code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
    `${privateSourceEntry} must not bypass package exports`,
  )
}

test("plugin packages and public SDKs resolve only through declared, package-local public boundaries", () => {
  const runtime = packageEntries.get(path.resolve(repoRoot, "packages/nano-runtime"))
  assert.ok(runtime, "Runtime host package is missing")
  const runtimeApplication = resolvePublicSpecifier("@nano/runtime/application")
  assert.ok(within(runtime.root, runtimeApplication), "The runtime composition subpath must resolve within the host package")

  for (const entry of [...inventory.plugins, ...inventory.publicApis]) assertExportsResolve(entry)
  publicPackageImportGraph([...inventory.plugins, ...inventory.publicApis], inventory.plugins, inventory.appNames)
})

test("an independently packaged plugin uses the same native Cordis runtime and contributions", async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "nano-public-plugin-fixture-"))
  const fixtureRoot = path.join(temporaryRoot, "external-plugin")
  const fixtureDependencies = path.join(fixtureRoot, "node_modules/@nano")
  try {
    mkdirSync(path.join(fixtureRoot, "src"), { recursive: true })
    mkdirSync(fixtureDependencies, { recursive: true })
    mkdirSync(path.join(temporaryRoot, "node_modules/@nano"), { recursive: true })
    writeFileSync(path.join(fixtureRoot, "package.json"), JSON.stringify({
      name: "@nano/external-boundary-fixture",
      version: "1.0.0",
      type: "module",
      exports: { ".": { import: "./dist/index.js", require: "./dist/index.js" } },
      files: ["dist"],
      dependencies: { "@nano/plugins": "*", "@nano/runtime-api": "*" },
      peerDependencies: { "@deepseek-ai/cordis": "4.0.4" },
    }, null, 2))
    symlinkSync(path.join(repoRoot, "packages/nano-plugins"), path.join(fixtureDependencies, "plugins"), "dir")
    symlinkSync(path.join(repoRoot, "packages/nano-runtime-api"), path.join(fixtureDependencies, "runtime-api"), "dir")
    symlinkSync(fixtureRoot, path.join(temporaryRoot, "node_modules/@nano/external-boundary-fixture"), "dir")
    const cordisRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@deepseek-ai/cordis"))), "..")
    mkdirSync(path.join(fixtureRoot, "node_modules/@deepseek-ai"), { recursive: true })
    symlinkSync(cordisRoot, path.join(fixtureRoot, "node_modules/@deepseek-ai/cordis"), "dir")

    const sourcePath = path.join(fixtureRoot, "src/index.ts")
    writeFileSync(sourcePath, `import { Context } from "@deepseek-ai/cordis"
import { defineService, listContributions, nano } from "@nano/runtime-api"
import type { Plugin } from "@nano/plugins"

export const cordisConstructor = Context
export const fixtureValue = defineService<{ revision: number; strategies: string[] }>("boundary.external-fixture")

export function createExternalPlugin(revision: number): Plugin {
  return {
    name: "external-boundary-fixture",
    inject: ["nano.contributions"],
    provide: fixtureValue.name,
    apply(ctx) {
      ctx.provide(fixtureValue.name, {
        revision,
        strategies: listContributions(ctx, nano.strategies).map(({ key }) => key).sort(),
      })
    },
  }
}
`)
    const compilerOptions: ts.CompilerOptions = {
      esModuleInterop: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      typeRoots: [path.join(repoRoot, "node_modules/@types")],
      types: ["node"],
    }
    const program = ts.createProgram([sourcePath], compilerOptions)
    const diagnostics = ts.getPreEmitDiagnostics(program)
      .filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
    const formatHost: ts.FormatDiagnosticsHost = {
      getCanonicalFileName: fileName => fileName,
      getCurrentDirectory: () => temporaryRoot,
      getNewLine: () => os.EOL,
    }
    assert.deepEqual(diagnostics, [], ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost))

    const output = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: sourcePath,
      reportDiagnostics: true,
    })
    assert.deepEqual(
      output.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? [],
      [],
      "The isolated plugin package source must transpile",
    )
    mkdirSync(path.join(fixtureRoot, "dist"), { recursive: true })
    writeFileSync(path.join(fixtureRoot, "dist/index.js"), output.outputText)

    const requireFromFixture = createRequire(path.join(temporaryRoot, "consumer.cjs"))
    const entryPath = requireFromFixture.resolve("@nano/external-boundary-fixture")
    assert.equal(realpathSync(entryPath), realpathSync(path.join(fixtureRoot, "dist/index.js")))
    assert.ok(within(temporaryRoot, realpathSync(entryPath)), "The fixture resolves to its own packaged entry, not workspace source")

    // The generated fixture entry exists only at runtime; load its installed public boundary.
    const fixtureApi = await import(pathToFileURL(entryPath).href) as {
      createExternalPlugin: (revision: number) => Plugin
      fixtureValue: ServiceToken<{ revision: number; strategies: string[] }>
      cordisConstructor: RuntimeApiExports["CordisContext"]
    }
    const { createExternalPlugin, fixtureValue, cordisConstructor } = fixtureApi
    const { CordisContext, Contributions, getService, findService, listContributions, nano } = runtimeApi
    assert.equal(cordisConstructor, CordisContext, "External plugins and the SDK must resolve the same Cordis constructor, not merely its global brand")
    assert.equal(cordisConstructor, NativeCordisContext)
    const ctx = new CordisContext()
    const expectedStrategies = ["companion", "context-full", "off", "remote", "snapcompact"]
    try {
      await ctx.plugin(Contributions)
      const builtIn = await ctx.plugin(contextStrategiesPlugin)
      assert.deepEqual(listContributions(ctx, nano.strategies).map(({ key }) => key).sort(), expectedStrategies)
      const external = await ctx.plugin(createExternalPlugin(1))
      assert.deepEqual(getService(ctx, fixtureValue), { revision: 1, strategies: expectedStrategies })
      await external.dispose()
      assert.equal(findService(ctx, fixtureValue), undefined)
      assert.deepEqual(listContributions(ctx, nano.strategies).map(({ key }) => key).sort(), expectedStrategies)
      await builtIn.dispose()
      assert.deepEqual(listContributions(ctx, nano.strategies), [])
      await ctx.plugin(createExternalPlugin(2))
      assert.deepEqual(getService(ctx, fixtureValue), { revision: 2, strategies: [] })
    } finally {
      await ctx.fiber.dispose()
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test("source-exported web plugins require Cordis and render from an isolated package layout", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "nano-web-package-fixture-"))
  try {
    const nanoModules = path.join(temporaryRoot, "node_modules/@nano")
    mkdirSync(nanoModules, { recursive: true })
    const packagesToCopy = [
      { name: "web-api", directory: "packages/nano-web-api", content: "src" },
      { name: "plugin-web-builtins", directory: "packages/plugins/web-builtins", content: "src" },
      { name: "plugins", directory: "packages/nano-plugins", content: "dist" },
      { name: "protocol", directory: "packages/nano-protocol", content: "dist" },
    ]
    for (const { name, directory, content } of packagesToCopy) {
      const sourceRoot = path.join(repoRoot, directory)
      const targetRoot = path.join(nanoModules, name)
      mkdirSync(targetRoot, { recursive: true })
      cpSync(path.join(sourceRoot, "package.json"), path.join(targetRoot, "package.json"))
      cpSync(path.join(sourceRoot, content), path.join(targetRoot, content), { recursive: true })
    }

    symlinkSync(path.dirname(fileURLToPath(import.meta.resolve("react"))), path.join(temporaryRoot, "node_modules/react"), "dir")
    symlinkSync(path.dirname(fileURLToPath(import.meta.resolve("react-dom/server"))), path.join(temporaryRoot, "node_modules/react-dom"), "dir")
    const renderScript = path.join(temporaryRoot, "render.mjs")
    writeFileSync(renderScript, `import { renderToStaticMarkup } from "react-dom/server"
import { Contributions } from "@nano/plugins"
import { createWebUI } from "@nano/web-api"
import { builtInWebPlugin } from "@nano/plugin-web-builtins"

const ui = createWebUI()
try {
  await ui.ctx.plugin(Contributions)
  await ui.ctx.plugin(builtInWebPlugin)
  const context = {
    panels: [],
    panelNameDraft: "",
    panelDraft: "",
    panelTokenDraft: "",
    refresh() {},
    connect() {},
    setPanelNameDraft() {},
    setPanelDraft() {},
    setPanelTokenDraft() {},
  }
  console.log(renderToStaticMarkup(ui.renderWebPanels("left", context)))
} finally {
  await ui.ctx.fiber.dispose()
}
`)
    const missingRuntime = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), renderScript], {
      cwd: temporaryRoot,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
      timeout: 15_000,
    })
    assert.notEqual(missingRuntime.status, 0, "Missing Cordis must fail instead of falling back to a private kernel")
    assert.match(missingRuntime.stderr, /Cannot find package '@deepseek-ai\/cordis'/)
    mkdirSync(path.join(temporaryRoot, "node_modules/@deepseek-ai"), { recursive: true })
    symlinkSync(path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@deepseek-ai/cordis"))), ".."), path.join(temporaryRoot, "node_modules/@deepseek-ai/cordis"), "dir")
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), renderScript], {
      cwd: temporaryRoot,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
      timeout: 15_000,
    })
    assert.equal(result.status, 0, `Isolated source-package render failed: ${result.stderr || result.error?.message || "no child-process diagnostics"}`)
    assert.match(result.stdout, /aria-label="control panels"/, "The built-in web panel must render through its public source export")
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test("source plugin type declarations resolve from each package's production dependencies", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "nano-plugin-type-fixture-"))
  try {
    const typeCases: Array<{ entry: WorkspacePackage; kind: "sqlite" | "node" | "jsx" }> = []
    for (const entry of inventory.plugins) {
      const files = sourceFiles(entry.root)
      const imports = files.flatMap(moduleSpecifiers).map(({ specifier }) => specifier)
      if (imports.includes("better-sqlite3")) typeCases.push({ entry, kind: "sqlite" })
      if (imports.some(isBuiltin)) typeCases.push({ entry, kind: "node" })
      if (files.some(fileName => fileName.endsWith(".tsx"))) typeCases.push({ entry, kind: "jsx" })
    }
    assert.ok(typeCases.length > 0, "No source plugin type declaration boundaries were discovered")

    for (const { entry, kind } of typeCases) {
      const fixtureName = `${entry.manifest.name.replaceAll("/", "_")}-${kind}`
      const fixtureRoot = path.join(temporaryRoot, fixtureName)
      mkdirSync(fixtureRoot, { recursive: true })
      cpSync(path.join(entry.root, "package.json"), path.join(fixtureRoot, "package.json"))
      cpSync(path.join(entry.root, "src"), path.join(fixtureRoot, "src"), { recursive: true })

      const productionDependencies = new Set([
        ...Object.keys(entry.manifest.dependencies ?? {}),
        ...Object.keys(entry.manifest.peerDependencies ?? {}),
      ])
      const requiredDependencies = kind === "sqlite"
        ? ["better-sqlite3", "@types/better-sqlite3"]
        : kind === "node"
          ? ["@types/node"]
          : ["react", "@types/react"]
      const linkedPackages = new Set<string>()
      const linkRegistryPackage = (name: string): void => {
        if (linkedPackages.has(name)) return
        const registryRoot = path.join(repoRoot, "node_modules", ...name.split("/"))
        if (!existsSync(registryRoot)) return
        const localRoot = path.join(fixtureRoot, "node_modules", ...name.split("/"))
        mkdirSync(path.dirname(localRoot), { recursive: true })
        symlinkSync(registryRoot, localRoot, "dir")
        linkedPackages.add(name)
        if (name.startsWith("@types/")) {
          const typeManifest = JSON.parse(readFileSync(path.join(registryRoot, "package.json"), "utf8")) as PackageManifest
          for (const dependency of Object.keys(typeManifest.dependencies ?? {})) linkRegistryPackage(dependency)
        }
      }
      for (const dependency of requiredDependencies) {
        if (productionDependencies.has(dependency)) linkRegistryPackage(dependency)
      }

      const probeSource = kind === "sqlite"
        ? `import type Database from "better-sqlite3"\ndeclare const database: Database.Database\nconst changes: number = database.prepare("select 1").run().changes\n`
        : kind === "node"
          ? `/// <reference types="node" />\nimport type { Stats } from "node:fs"\ndeclare const stats: Stats\n`
          : `const element = <section aria-label="type fixture">ready</section>\n`
      const probePath = path.join(fixtureRoot, "consumer.tsx")
      writeFileSync(probePath, probeSource)
      const program = ts.createProgram([probePath], {
        esModuleInterop: true,
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
        preserveSymlinks: true,
        strict: true,
        target: ts.ScriptTarget.ES2022,
        typeRoots: [path.join(fixtureRoot, "node_modules/@types")],
        types: kind === "node" ? ["node"] : [],
      })
      const diagnostics = ts.getPreEmitDiagnostics(program)
        .filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
      const formatHost: ts.FormatDiagnosticsHost = {
        getCanonicalFileName: fileName => fileName,
        getCurrentDirectory: () => fixtureRoot,
        getNewLine: () => os.EOL,
      }
      assert.deepEqual(
        diagnostics,
        [],
        `${entry.manifest.name} ${kind} declaration resolution failed:\n${ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost)}`,
      )
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
})
