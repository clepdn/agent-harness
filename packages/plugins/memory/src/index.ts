import type { Plugin, CordisContext } from "@nano/plugins"
import { createAgentStateService } from "@nano/runtime-api/agent-state-tools"
import { createMemoryApplicationService, createMemoryRuntime } from "@nano/runtime-api/memory"
import { findService, getService, nano, type EmbeddingsService, type MemoryService } from "@nano/runtime-api"

export const memoryPlugin: Plugin.Object = {
  name: "nano.memory",
  inject: ["nano.persistence", "nano.client", "nano.bootstrap"],
  provide: "nano.memory",
  apply(ctx: CordisContext) {
    const persistence = getService(ctx, nano.persistence)
    const client = getService(ctx, nano.client)
    const bootstrap = getService(ctx, nano.bootstrap)
    // Optional providers are resolved at operation time so late-loaded features remain visible.
    const embeddings: EmbeddingsService = {
      get model() { return findService(ctx, nano.embeddings)?.model ?? "" },
      get dimensions() { return findService(ctx, nano.embeddings)?.dimensions ?? 0 },
      configured: () => findService(ctx, nano.embeddings)?.configured() ?? false,
      embedTexts: (texts, signal) => {
        const service = findService(ctx, nano.embeddings)
        if (!service) return Promise.reject(new Error("Embeddings service is unavailable"))
        return service.embedTexts(texts, signal)
      },
    }
    const runtime = createMemoryRuntime({
      home: persistence.home,
      persistence,
      embeddings,
      searchDiscord: (query, limit, vector, runtimeKind) => {
        const discord = findService(ctx, nano.discord)
        return discord?.available ? discord.searchMessages(query, limit, vector, runtimeKind) : Promise.resolve([])
      },
      recordMetric: (event) => findService(ctx, nano.metrics)?.recordMetric(event),
      memoryExcerptImageReferences: (text, filePath) => {
        const images = findService(ctx, nano.images)
        return images ? images.memoryExcerptImageReferences(text, filePath) : Promise.resolve([])
      },
    })
    const agentState = createAgentStateService({
      home: persistence.home,
      readClientFile: (filePath, maxBytes, timeoutMs) => client.readFile(filePath, maxBytes, timeoutMs),
      persistence: { recordStateRevision: (filePath, source) => persistence.recordStateRevision(filePath, source) },
      bootstrap: {
        readFrontendSoul: () => bootstrap.readFrontendSoul(),
        writeFrontendSoul: (expectedSoul, content) => bootstrap.writeFrontendSoul(expectedSoul, content),
      },
      syncMemoryIndex: () => runtime.syncMemoryIndex(),
    })
    const application = createMemoryApplicationService(runtime, agentState)
    const service: MemoryService = {
      memoryFs: application.memoryFs,
      readMemory: application.readMemory,
      listMemory: application.listMemory,
      grepMemory: application.grepMemory,
      editMemoryResource: application.editMemoryResource,
      editMemoryResourceHashline: application.editMemoryResourceHashline,
      writeMemory: application.writeMemory,
      writeSoul: application.writeSoul,
      loadSkill: application.loadSkill,
      search: application.search,
      recall: application.recall,
      remember: application.remember,
      syncMemoryIndex: application.syncMemoryIndex,
      listAliases: application.listAliases,
      setAlias: application.setAlias,
      removeAlias: application.removeAlias,
    }
    ctx.provide(nano.memory.name, service)
  },
}
