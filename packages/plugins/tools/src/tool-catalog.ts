import type { ToolDefinition } from "@nano/harness-core"
import type { ToolCapability, WorkspaceDescriptor } from "@nano/harness-protocol"
import type { ToolCatalogContext, ToolContribution } from "@nano/runtime-api"
import type { RuntimeKind } from "@nano/runtime-api/contracts/runner"

export type NiriToolCatalogOptions = {
  clientCapabilities?: Iterable<ToolCapability>
  workspace?: WorkspaceDescriptor | null
  computer?: boolean
  vision?: boolean
  frontend?: boolean
  runtimeKind?: RuntimeKind
  contributions?: readonly ToolContribution[]
}

function createContributionCatalog(options: NiriToolCatalogOptions): ToolDefinition[] {
  const capabilities = new Set(options.clientCapabilities ?? [])
  const context: ToolCatalogContext = {
    runtimeKind: options.runtimeKind ?? (options.frontend ? "frontend" : "main"),
    clientCapabilities: capabilities,
    workspace: options.workspace ?? null,
    vision: options.vision ?? capabilities.has("image_tool"),
    computer: options.computer ?? capabilities.has("computer"),
  }
  const seen = new Set<string>()
  const result: ToolDefinition[] = []
  for (const entry of options.contributions ?? []) {
    const name = entry.definition.function.name
    if (seen.has(name)) continue
    if (entry.runtimeKinds && !entry.runtimeKinds.includes(context.runtimeKind)) continue
    if (entry.clientCapabilities && entry.clientCapabilities.some((capability) => !capabilities.has(capability))) continue
    if (entry.requiresVision && !context.vision) continue
    if (entry.requiresComputer && !context.computer) continue
    if (entry.availableFor && !entry.availableFor(context)) continue
    const definition = entry.definitionFor ? entry.definitionFor(context) : entry.definition
    if (definition.function.name !== name) throw new Error(`definitionFor changed tool name from ${name} to ${definition.function.name}`)
    seen.add(name)
    result.push(definition)
  }
  return result
}

export function createNiriToolCatalog(options: NiriToolCatalogOptions): ToolDefinition[] {
  if (!options.contributions) throw new Error("Tool contributions are required to build a public catalog")
  return createContributionCatalog(options)
}

/** Replace only image_tool in a restored pinned catalog when URL support or vision availability changed. */
export function reconcileImageToolDefinition(
  saved: readonly ToolDefinition[],
  current: readonly ToolDefinition[],
): { catalog: ToolDefinition[]; changed: boolean } {
  const desired = current.find((tool) => tool.function.name === "image_tool")
  const existing = saved.find((tool) => tool.function.name === "image_tool")
  if (JSON.stringify(existing) === JSON.stringify(desired)) return { catalog: [...saved], changed: false }
  const catalog = saved.filter((tool) => tool.function.name !== "image_tool")
  if (desired) {
    const readIndex = catalog.findIndex((tool) => tool.function.name === "read_file")
    catalog.splice(readIndex < 0 ? catalog.length : readIndex, 0, desired)
  }
  return { catalog, changed: true }
}

/** Refresh memory file contracts in a restored session's pinned catalog. */
export function reconcileMemoryFileToolDefinitions(
  saved: readonly ToolDefinition[],
  current: readonly ToolDefinition[],
): { catalog: ToolDefinition[]; changed: boolean } {
  const catalog = [...saved]
  let changed = false
  for (const name of ["read_file", "edit_file", "memory_fs"]) {
    const desired = current.find((tool) => tool.function.name === name)
    if (!desired) continue
    const existingIndex = catalog.findIndex((tool) => tool.function.name === name)
    if (existingIndex >= 0 && JSON.stringify(catalog[existingIndex]) === JSON.stringify(desired)) continue
    if (existingIndex >= 0) catalog.splice(existingIndex, 1, desired)
    else catalog.push(desired)
    changed = true
  }
  return { catalog, changed }
}
