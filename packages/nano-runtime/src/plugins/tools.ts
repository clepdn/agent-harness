import type { Plugin } from "@nano/plugins"
import { nano } from "./api"
import type { ToolService } from "./api"
import { createNiriToolCatalog } from "../runner/tool-catalog"
import { getCompletionTools } from "../runner/tools"

export const toolsPlugin: Plugin = {
  id: "nano.tools",
  optional: [nano.model, nano.client],
  provides: [nano.tools],
  apply(scope) {
    const model = scope.optional(nano.model)
    const client = scope.optional(nano.client)
    const list: ToolService["list"] = (runtimeKind) => {
      const contributions = scope.list(nano.toolContributions).map((entry) => entry.value)
      const catalog = createNiriToolCatalog({
        contributions,
        clientCapabilities: runtimeKind === "frontend" ? [] : client?.capabilities(),
        workspace: client?.workspace(),
        frontend: runtimeKind === "frontend",
        vision: model?.current(runtimeKind).primaryVision,
      })
      const definitions = getCompletionTools(catalog, {
        runtimeKind,
        vision: model?.current(runtimeKind).primaryVision,
        imageRoot: client?.workspace()?.imageRoot,
      })
      const available = new Map(definitions.map((definition) => [definition.name, definition]))
      const catalogByName = new Map(catalog.map((definition) => [definition.function.name, definition]))
      return contributions.flatMap((entry) => {
        const definition = available.get(entry.definition.function.name)
        if (!definition) return []
        const catalogDefinition = catalogByName.get(definition.name)
        if (!catalogDefinition) return []
        return [{ ...entry, definition: {
          ...catalogDefinition,
          function: { ...catalogDefinition.function, description: definition.description },
        } }]
      })
    }
    const service: ToolService = {
      list: scope.guard(list),
      execute: scope.guard(async (name, input, context) => {
        context.signal.throwIfAborted()
        const entry = list(context.runtimeKind).find((candidate) => candidate.definition.function.name === name)
        if (!entry) throw new Error(`Tool "${name}" is unavailable`)
        return entry.execute(input, {
          ...context,
          signal: AbortSignal.any([context.signal, scope.signal]),
        })
      }),
    }
    return scope.provide(nano.tools, service)
  },
}
