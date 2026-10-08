import type { Plugin } from "@nano/plugins"
import { nano, type RuntimeExecutionServices, type SubagentService } from "./api"
import { createSubagentService } from "../runner/subagent"

export const subagentsPlugin: Plugin = {
  id: "nano.subagents",
  requires: [nano.model, nano.tools, nano.persistence],
  optional: [nano.memory, nano.discord, nano.metrics, nano.events, nano.contextManagement, nano.client, nano.images],
  provides: [nano.subagents],
  apply(scope) {
    const model = scope.use(nano.model)
    const tools = scope.use(nano.tools)
    const persistence = scope.use(nano.persistence)
    const memory = scope.optional(nano.memory)
    const discord = scope.optional(nano.discord)
    const metrics = scope.optional(nano.metrics)
    const events = scope.optional(nano.events)
    const contextManagement = scope.optional(nano.contextManagement)
    const client = scope.optional(nano.client)
    const images = scope.optional(nano.images)
    const services: RuntimeExecutionServices = {
      providerResolver: model.resolver(),
      model,
      tools,
      persistence,
      ...(memory ? { memory } : {}),
      ...(discord ? { discord } : {}),
      ...(metrics ? { metrics } : {}),
      ...(events ? { events } : {}),
      ...(contextManagement ? { contextManagement } : {}),
      ...(client ? { client } : {}),
      ...(images ? { images } : {}),
    }
    const bound = createSubagentService(services)
    const controller = new AbortController()
    const active = new Set<Promise<string>>()
    scope.own(async () => {
      controller.abort()
      await Promise.allSettled(active)
    })
    const service: SubagentService = {
      findSubagent: scope.guard(bound.findSubagent),
      runSubagent: scope.guard((convId, subagent, task, signal, runtimeKind) => {
        const combined = AbortSignal.any([scope.signal, controller.signal, ...(signal ? [signal] : [])])
        combined.throwIfAborted()
        const run = bound.runSubagent(convId, subagent, task, combined, runtimeKind).then((result) => {
          combined.throwIfAborted()
          return result
        })
        active.add(run)
        void run.then(() => active.delete(run), () => active.delete(run))
        return run
      }),
    }
    const remove = scope.provide(nano.subagents, service)
    return remove
  },
}
