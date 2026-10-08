import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import ts from "typescript"

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/nano-runtime-api/src")

// These are executable public SDK/core APIs, not homes for plugin features.
// Feature contracts belong in contracts/ and must erase completely at runtime.
const coreExports: Record<string, ReadonlySet<string>> = {
  "index.ts": new Set([
    "CordisContext", "Fiber", "Service", "Contributions", "configSchema", "defineService", "defineSlot", "defineEvent",
    "getService", "findService", "registerContribution", "listContributions", "watchContributions", "onEvent", "emitEvent",
    "registerOperation", "registerStream", "nano", "registerTool", "registerCommand", "modelProviderResolver", "MEMORY_EMBEDDING_DIMENSIONS", "MEMORY_SEMANTIC_MIN_SIMILARITY",
  ]),
  "llm.ts": new Set(["Context", "ContextChangedError", "CompletionRequestError", "AssistantMessageEventStream", "stream", "complete"]),
  "model-api.ts": new Set(["modelProviders", "registerModelProvider", "completeModel", "streamModel", "AssistantMessageEventStream", "Context", "ContextChangedError", "CompletionRequestError"]),
  "model-events.ts": new Set(["AssistantMessageEventStream"]),
  "config.ts": new Set(["config", "getModelPreset", "listModelPresets", "validatePluginSelections", "redactSecrets"]),
  "agent-config.ts": new Set(["AGENT_ID", "REPO_ROOT", "NANO_HOME", "resolveNiriHome"]),
  // Config/cache policy is shared by the fixed Context/config core, model and runner.
  "cache-policy.ts": new Set(["cacheLifetimeMinutes", "respectPromptCache", "cacheRefreshIntervalMs", "idleCacheCompactionMs"]),
  // Atomic durable IO is shared infrastructure used by distinct feature owners.
  "durable-file.ts": new Set(["isMissingFileError", "atomicWriteFile", "quarantineFile"]),
  // The same typed transport serves both worker HTTP and control HTTP owners.
  "rpc-gateway.ts": new Set(["authenticateRpcRequest", "authorizeRpcRequest", "invokeRpcOperation", "prepareRpcStream", "invokeRpcStream", "rpcErrorStatus", "rpcErrorValue", "createRpcGateway", "registerRpcTransport", "rpcGatewayPlugin"]),
  "text.ts": new Set(["normalizeText"]),
  "media.ts": new Set(["imageMime"]),
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? files(file) : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [file] : []
  })
}

function exportedValues(source: ts.SourceFile): string[] {
  const values: string[] = []
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue
      assert.ok(statement.exportClause && ts.isNamedExports(statement.exportClause), `${source.fileName} must not hide implementation behind a value wildcard export`)
      for (const entry of statement.exportClause.elements) if (!entry.isTypeOnly) values.push(entry.name.text)
      continue
    }
    if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        assert.ok(ts.isIdentifier(declaration.name), `${source.fileName} has an unaccounted destructured public value`)
        values.push(declaration.name.text)
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      values.push(statement.name.text)
    } else {
      assert.fail(`${source.fileName} has an unaccounted public executable declaration`)
    }
  }
  return values
}

function assertTypeOnly(source: ts.SourceFile): void {
  for (const statement of source.statements) {
    const typeDeclaration = ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
    const typeImport = ts.isImportDeclaration(statement) && Boolean(statement.importClause?.isTypeOnly)
    const typeExport = ts.isExportDeclaration(statement) && (statement.isTypeOnly || Boolean(statement.exportClause && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.every(entry => entry.isTypeOnly)))
    assert.ok(typeDeclaration || typeImport || typeExport || ts.isEmptyStatement(statement), `${source.fileName} contains executable feature behavior; contract modules must erase at runtime`)
  }
}

test("runtime API exposes contracts and fixed core, never plugin feature implementations", () => {
  for (const file of files(apiRoot)) {
    const relative = path.relative(apiRoot, file).split(path.sep).join("/")
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
    const allowed = coreExports[relative]
    if (allowed) {
      for (const name of exportedValues(source)) assert.ok(allowed.has(name), `${relative} exports feature implementation ${name}; move implementation to its owning plugin, not the public SDK`)
    } else {
      assert.ok(relative.startsWith("contracts/") || relative === "types.ts", `${relative} is not a public contract or fixed runtime core; its feature implementation belongs to a plugin`)
      assertTypeOnly(source)
    }
  }
})
