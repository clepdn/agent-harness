import type { Plugin, CordisContext } from "@nano/plugins"
import { config } from "@nano/runtime-api/config"
import { journalCompactionSummary, resolveDeepArchiveBackend, initSnapcompactRenderer } from "./compaction-companion"
import {
  loadAgentSummaryContext,
  proactiveCompaction,
  summarizeConversationViaLLM,
} from "./summarize"
import type { SummaryOptions } from "@nano/runtime-api/contracts/context-management"
import { getService, findService, nano, type ContextManagementService } from "@nano/runtime-api"

export const contextManagementPlugin: Plugin.Object = {
  name: "nano.context-management",
  inject: ["nano.model", "nano.persistence", "nano.bootstrap"],
  provide: "nano.context-management",
  async apply(ctx: CordisContext) {
    const model = getService(ctx, nano.model)
    const bootstrap = getService(ctx, nano.bootstrap)
    const persistence = getService(ctx, nano.persistence)
    const providerResolver = model.resolver()
    const lanes = [model.current("main"), ...(config.frontend.enable ? [model.current("frontend")] : [])]
    if (lanes.some((lane) => lane.primaryVision && (lane.deepArchive || lane.compactionStrategy === "snapcompact"))) {
      await initSnapcompactRenderer()
    }
    const service: ContextManagementService = {
      loadAgentSummaryContext: (runtimeKind) => loadAgentSummaryContext({ home: persistence.home, readFrontendSoul: bootstrap.readFrontendSoul }, runtimeKind),
      summarizeConversation: (messages, summaryModel, apiKey, options?: SummaryOptions) =>
        summarizeConversationViaLLM(messages, summaryModel, apiKey, {
          ...options,
          providerResolver,
          contextStore: persistence,
        }),
      proactiveCompaction: (messages, compactionModel, apiKey, turnAge, minChars) =>
        proactiveCompaction(messages, compactionModel, apiKey, turnAge, minChars, undefined, providerResolver),
      resolveDeepArchiveBackend: (provider, forceSnapcompact, runtimeModelState) =>
        resolveDeepArchiveBackend(provider, forceSnapcompact ?? false, runtimeModelState ?? model.current("main")),
      journalCompactionSummary: (summaryText) => {
        const memory = findService(ctx, nano.memory)
        return journalCompactionSummary(summaryText, memory?.writeMemory)
      },
      archiveContextMessages: persistence.archiveContextMessages.bind(persistence),
      recordContextCompaction: persistence.recordContextCompaction.bind(persistence),
      recordRestContextSnapshot: persistence.recordRestContextSnapshot.bind(persistence),
      grepContext: persistence.grepContext.bind(persistence),
      describeContextSummary: persistence.describeContextSummary.bind(persistence),
      expandContextSummary: persistence.expandContextSummary.bind(persistence),
    }
    ctx.provide(nano.contextManagement.name, service)
  },
}

export { journalCompactionSummary, resolveDeepArchiveBackend, initSnapcompactRenderer } from "./compaction-companion"
export { loadAgentSummaryContext, proactiveCompaction, summarizeConversationViaLLM } from "./summarize"
export type { SummaryOptions } from "@nano/runtime-api/contracts/context-management"
export { meetsToolResultCompactionContextThreshold, COMPACTION_STRATEGY, CONTEXT_COMPACT_TRIGGER_TOKENS, DEEP_ARCHIVE_ENABLED, JOURNAL_BEFORE_COMPACTION, REMOTE_COMPACTION_ENDPOINT, REMOTE_COMPACTION_MODEL, REMOTE_COMPACTION_STREAMING_ENDPOINT, RESPECT_PROMPT_CACHE, TOOL_RESULT_COMPACTION_MIN_AGE_TURNS, TOOL_RESULT_COMPACTION_MIN_CHARS, TOOL_RESULT_COMPACTION_MIN_CONTEXT_PERCENT } from "./settings"
export { fallbackContextWindow } from "./summarize"
export type { DeepArchiveBackend, DeepArchiveResult, SummaryContextDependencies } from "@nano/runtime-api/contracts/context-management"
