import type { Plugin } from "@nano/plugins"
import { findService, getService, nano } from "@nano/runtime-api"
import type { RuntimeExecutionServices } from "@nano/runtime-api"
import type { SubagentService } from "@nano/runtime-api/contracts/subagents"
import { createSubagentService } from "./runtime"

export const subagentsPlugin: Plugin = {
  name: "nano.subagents",
  inject: [nano.model.name, nano.tools.name, nano.persistence.name],
  provide: nano.subagents.name,
  apply(ctx) {
    const model = getService(ctx, nano.model)
    const tools = getService(ctx, nano.tools)
    const persistence = getService(ctx, nano.persistence)
    const services: RuntimeExecutionServices = {
      providerResolver: model.resolver(),
      model,
      tools,
      persistence,
      get memory() { return findService(ctx, nano.memory) },
      get discord() { return findService(ctx, nano.discord) },
      get metrics() { return findService(ctx, nano.metrics) },
      get events() { return findService(ctx, nano.events) },
      get contextManagement() { return findService(ctx, nano.contextManagement) },
      get client() { return findService(ctx, nano.client) },
      get images() { return findService(ctx, nano.images) },
    }
    const bound = createSubagentService(services)
    const controller = new AbortController()
    const active = new Set<Promise<string>>()
    ctx.effect(() => async () => {
      controller.abort()
      await Promise.allSettled(active)
    })
    const service: SubagentService = {
      findSubagent: bound.findSubagent,
      runSubagent: (convId, subagent, task, signal, runtimeKind) => {
        const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
        combined.throwIfAborted()
        const run = bound.runSubagent(convId, subagent, task, combined, runtimeKind).then((result) => {
          combined.throwIfAborted()
          return result
        })
        active.add(run)
        void run.then(() => active.delete(run), () => active.delete(run))
        return run
      },
    }
    ctx.provide(nano.subagents.name, service)
  },
}
export { createSubagentService } from "./runtime"
