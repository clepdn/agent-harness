import type { Plugin, PluginScope } from "@nano/plugins"
import { config } from "../config"
import { journalCompactionSummary, resolveDeepArchiveBackend, initSnapcompactRenderer } from "../runner/compaction-companion"
import {
  loadAgentSummaryContext,
  proactiveCompaction,
  summarizeConversationViaLLM,
} from "../runner/summarize"
import type { SummaryOptions } from "../runner/summarize"
import { nano, type ContextManagementService } from "./api"

export const contextManagementPlugin: Plugin = {
  id: "nano.context-management",
  requires: [nano.model, nano.persistence, nano.bootstrap],
  optional: [nano.memory],
  provides: [nano.contextManagement],
  async apply(scope: PluginScope) {
    const model = scope.use(nano.model)
    const bootstrap = scope.use(nano.bootstrap)
    const persistence = scope.use(nano.persistence)
    const memory = scope.optional(nano.memory)
    const providerResolver = model.resolver()
    const lanes = [model.current("main"), ...(config.frontend.enable ? [model.current("frontend")] : [])]
    if (lanes.some((lane) => lane.primaryVision && (lane.deepArchive || lane.compactionStrategy === "snapcompact"))) {
      await initSnapcompactRenderer()
      scope.signal.throwIfAborted()
    }
    const service: ContextManagementService = {
      loadAgentSummaryContext: scope.guard((runtimeKind) => loadAgentSummaryContext({ home: persistence.home, readFrontendSoul: bootstrap.readFrontendSoul }, runtimeKind)),
      summarizeConversation: scope.guard((messages, summaryModel, apiKey, options?: SummaryOptions) =>
        summarizeConversationViaLLM(messages, summaryModel, apiKey, {
          ...options,
          providerResolver,
          contextStore: persistence,
        })),
      proactiveCompaction: scope.guard((messages, compactionModel, apiKey, turnAge, minChars) =>
        proactiveCompaction(messages, compactionModel, apiKey, turnAge, minChars, undefined, providerResolver)),
      resolveDeepArchiveBackend: scope.guard((provider, forceSnapcompact, runtimeModelState) =>
        resolveDeepArchiveBackend(provider, forceSnapcompact ?? false, runtimeModelState ?? model.current("main"))),
      journalCompactionSummary: scope.guard((summaryText) =>
        journalCompactionSummary(summaryText, memory?.writeMemory ? scope.guard(memory.writeMemory) : undefined)),
      archiveContextMessages: scope.guard(persistence.archiveContextMessages.bind(persistence)),
      recordContextCompaction: scope.guard(persistence.recordContextCompaction.bind(persistence)),
      recordRestContextSnapshot: scope.guard(persistence.recordRestContextSnapshot.bind(persistence)),
      grepContext: scope.guard(persistence.grepContext.bind(persistence)),
      describeContextSummary: scope.guard(persistence.describeContextSummary.bind(persistence)),
      expandContextSummary: scope.guard(persistence.expandContextSummary.bind(persistence)),
    }
    return scope.provide(nano.contextManagement, service)
  },
}
