import type { Plugin, CordisContext } from "@nano/plugins"
import { nano, registerContribution, type CompactionStrategyRequest, type StrategyService } from "@nano/runtime-api"
import type { CompactionResult } from "@nano/runtime-api/runner/types"
import type { CompactionStrategy } from "@nano/runtime-api/config"

function strategy(id: CompactionStrategy): StrategyService {
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
      if (force || input.state.contextSize >= input.triggerTokens) return invoke()
      if (id === "companion") return "none"
      return input.runProactive()
    },
  }
}

/** Built-in policy contributions; the runner owns compaction algorithms. */
export const contextStrategiesPlugin: Plugin.Object = {
  name: "nano.context-strategies",
  inject: ["nano.contributions"],
  apply(ctx: CordisContext) {
    const registrations = ["off", "companion", "context-full", "remote", "snapcompact"] as const
    for (const id of registrations) registerContribution(ctx, nano.strategies, id, strategy(id))
  },
}
