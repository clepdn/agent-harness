import type { Plugin, PluginScope } from "@nano/plugins"
import { nano, type CompactionStrategyRequest, type StrategyService } from "./api"
import type { CompactionResult } from "../runner/types"
import type { CompactionStrategy } from "../config"
function strategy(id: CompactionStrategy, guard: <T extends (...args: never[]) => unknown>(callback: T) => T): StrategyService {
  return {
    id,
    async execute(input: CompactionStrategyRequest): Promise<CompactionResult> {
      if (id === "off" && !input.manual) return "none"
      const force = Boolean(input.force || input.manual || input.phase === "idle" || input.phase === "shutdown")
      const effective: CompactionStrategy = id === "snapcompact" ? "context-full" : id
      const invoke = () => input.runLLM(effective, force, {
        forceSummaryModel: Boolean(input.manual?.forceSummaryModel),
        forceSnapcompact: Boolean(input.manual?.snapcompact),
      })
      if (force || input.state.contextSize >= input.triggerTokens) return guard(invoke)()
      if (id === "companion") return "none"
      return guard(input.runProactive)()
    },
  }
}

/** Built-in policy contributions; the runner owns compaction algorithms. */
export const contextStrategiesPlugin: Plugin = {
  id: "nano.context-strategies",
  apply(scope: PluginScope) {
    const registrations = [
      ["off", strategy("off", scope.guard)],
      ["companion", strategy("companion", scope.guard)],
      ["context-full", strategy("context-full", scope.guard)],
      ["remote", strategy("remote", scope.guard)],
      ["snapcompact", strategy("snapcompact", scope.guard)],
    ] as const
    const cleanups = registrations.map(([id, value]) => scope.register(nano.strategies, id, value))
    return () => {
      for (const cleanup of cleanups.reverse()) cleanup()
    }
  },
}
