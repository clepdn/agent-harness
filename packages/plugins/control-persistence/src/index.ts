import type { Plugin } from "@nano/plugins"
import { CONTROL_STORE } from "@nano/control-api"
import { ControlStore } from "./db.js"

export { ControlStore }
export type { AgentRecord, MirroredCompaction, WorkerEvent } from "./db.js"

export function controlStorePlugin(store: ControlStore): Plugin.Object<unknown> {
  return {
    name: "control.persistence",
    provide: [CONTROL_STORE.name],
    apply(ctx) {
      store.initialize()
      ctx.provide(CONTROL_STORE.name, store)
      ctx.effect(() => () => store.close())
    },
  }
}
