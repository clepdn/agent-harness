import type { Plugin } from "@nano/plugins"
import { createAgentStateService } from "../agent-state-tools"
import { createMemoryApplicationService, createMemoryRuntime } from "../memory"
import { nano, type MemoryService } from "./api"

export const memoryPlugin: Plugin = {
  id: "nano.memory",
  requires: [nano.persistence, nano.client, nano.bootstrap],
  optional: [nano.embeddings, nano.discord, nano.metrics, nano.images, nano.events],
  provides: [nano.memory],
  apply(scope) {
    const persistence = scope.use(nano.persistence)
    const client = scope.use(nano.client)
    const bootstrap = scope.use(nano.bootstrap)
    const embeddings = scope.optional(nano.embeddings)
    const discord = scope.optional(nano.discord)
    const metrics = scope.optional(nano.metrics)
    const images = scope.optional(nano.images)
    const runtime = createMemoryRuntime({
      home: persistence.home,
      persistence,
      ...(embeddings ? { embeddings } : {}),
      ...(discord ? { searchDiscord: scope.guard((query, limit, vector, runtimeKind) => discord.available ? discord.searchMessages(query, limit, vector, runtimeKind) : Promise.resolve([])) } : {}),
      ...(metrics ? { recordMetric: scope.guard((event) => metrics.recordMetric(event)) } : {}),
      ...(images ? { memoryExcerptImageReferences: scope.guard((text, filePath) => images.memoryExcerptImageReferences(text, filePath)) } : {}),
    })
    const agentState = createAgentStateService({
      home: persistence.home,
      readClientFile: scope.guard((filePath, maxBytes, timeoutMs) => client.readFile(filePath, maxBytes, timeoutMs)),
      persistence: { recordStateRevision: scope.guard((filePath, source) => persistence.recordStateRevision(filePath, source)) },
      bootstrap: {
        readFrontendSoul: scope.guard(() => bootstrap.readFrontendSoul()),
        writeFrontendSoul: scope.guard((expectedSoul, content) => bootstrap.writeFrontendSoul(expectedSoul, content)),
      },
      syncMemoryIndex: scope.guard(() => runtime.syncMemoryIndex()),
    })
    const application = createMemoryApplicationService(runtime, agentState)
    const active = new Set<Promise<unknown>>()
    const tracked = <T>(result: T): T => {
      if (result instanceof Promise) {
        active.add(result)
        void result.then(() => active.delete(result), () => active.delete(result))
      }
      return result
    }
    scope.own(async () => {
      while (active.size) await Promise.allSettled(active)
    })
    const service: MemoryService = {
      memoryFs: scope.guard((...args) => tracked(application.memoryFs(...args))),
      readMemory: scope.guard((...args) => tracked(application.readMemory(...args))),
      listMemory: scope.guard((...args) => tracked(application.listMemory(...args))),
      grepMemory: scope.guard((...args) => tracked(application.grepMemory(...args))),
      editMemoryResource: scope.guard((...args) => tracked(application.editMemoryResource(...args))),
      editMemoryResourceHashline: scope.guard((...args) => tracked(application.editMemoryResourceHashline(...args))),
      writeMemory: scope.guard((...args) => tracked(application.writeMemory(...args))),
      writeSoul: scope.guard((...args) => tracked(application.writeSoul(...args))),
      loadSkill: scope.guard((...args) => tracked(application.loadSkill(...args))),
      search: scope.guard((...args) => tracked(application.search(...args))),
      recall: scope.guard((...args) => tracked(application.recall(...args))),
      remember: scope.guard((...args) => tracked(application.remember(...args))),
      syncMemoryIndex: scope.guard((...args) => tracked(application.syncMemoryIndex(...args))),
      listAliases: scope.guard((...args) => tracked(application.listAliases(...args))),
      setAlias: scope.guard((...args) => tracked(application.setAlias(...args))),
      removeAlias: scope.guard((...args) => tracked(application.removeAlias(...args))),
    }
    return scope.provide(nano.memory, service)
  },
}
