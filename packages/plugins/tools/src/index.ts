import type { Plugin } from "@nano/plugins"
import { findService, listContributions, nano } from "@nano/runtime-api"
import type { ToolService } from "@nano/runtime-api"
import { createNiriToolCatalog } from "@nano/runtime-api/runner/tool-catalog"
import { getCompletionTools } from "@nano/runtime-api/runner/tools"

export const toolsPlugin: Plugin = {
  name: "nano.tools",
  inject: ["nano.contributions"],
  provide: nano.tools.name,
  apply(ctx) {
    const list: ToolService["list"] = (runtimeKind) => {
      const contributions = listContributions(ctx, nano.toolContributions).map((entry) => entry.value)
      const client = findService(ctx, nano.client)
      const model = findService(ctx, nano.model)
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
      const available = Object.fromEntries(definitions.map((definition) => [definition.name, definition])) as Record<string, (typeof definitions)[number]>
      const catalogByName = Object.fromEntries(catalog.map((definition) => [definition.function.name, definition])) as Record<string, (typeof catalog)[number]>
      return contributions.flatMap((entry) => {
        const definition = available[entry.definition.function.name]
        if (!definition) return []
        const catalogDefinition = catalogByName[definition.name]
        if (!catalogDefinition) return []
        return [{ ...entry, definition: {
          ...catalogDefinition,
          function: { ...catalogDefinition.function, description: definition.description },
        } }]
      })
    }
    const service: ToolService = {
      list,
      execute: async (name, input, context) => {
        context.signal.throwIfAborted()
        const entry = list(context.runtimeKind).find((candidate) => candidate.definition.function.name === name)
        if (!entry) throw new Error(`Tool "${name}" is unavailable`)
        return entry.execute(input, context)
      },
    }
    ctx.provide(nano.tools.name, service)
  },
}
