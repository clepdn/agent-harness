import type { CordisContext, Plugin } from "@nano/plugins"
import { nano, type LifecycleService } from "@nano/runtime-api"

export function createLifecyclePlugin(lifecycle: LifecycleService): Plugin {
  return {
    name: "nano.lifecycle",
    provide: nano.lifecycle.name,
    apply(ctx: CordisContext) {
      ctx.provide(nano.lifecycle.name, {
        shutdown: () => lifecycle.shutdown(),
        restart: (reason?: string) => lifecycle.restart(reason),
      })
    },
  }
}
