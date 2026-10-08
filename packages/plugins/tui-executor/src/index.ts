import { defineService, type CordisContext, type Plugin } from "@nano/plugins"
import { startExecutor } from "./executor.js"
import type { ExecutorOptions, RunningExecutor } from "./executor.js"

export type { ExecutorOptions, RunningExecutor } from "./executor.js"
export { startExecutor } from "./executor.js"

export const executorResource = defineService<RunningExecutor>("nano.tui.executor")

export function createTuiExecutorPlugin(options: ExecutorOptions): Plugin {
  return {
    name: "nano.tui.executor",
    provide: [executorResource.name],
    async apply(ctx: CordisContext) {
      const executor = await startExecutor(options)
      ctx.effect(() => () => executor.stop())
      ctx.provide(executorResource.name, executor)
    },
  }
}
