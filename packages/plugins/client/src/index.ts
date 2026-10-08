import type { Plugin } from "@nano/plugins"
import type { ClientService } from "@nano/runtime-api"
import { emitEvent, nano } from "@nano/runtime-api"
import { createConfiguredToolClient, readClientFile } from "@nano/runtime-api/client"
import type { ConfiguredToolClientOptions } from "@nano/runtime-api/client"
import { fromClientLifecycle } from "@nano/runtime-api/triggers/client"

export type ClientPluginOptions = ConfiguredToolClientOptions

/** Install the configured client executor as a Cordis-owned runtime service. */
export function clientPlugin(options: ClientPluginOptions = {}): Plugin {
  return {
    name: "nano.client",
    provide: nano.client.name,
    async apply(ctx) {
      const client = createConfiguredToolClient(options)
      const controller = new AbortController()
      let started = false
      let startup: Promise<void> | undefined
      ctx.effect(() => async () => {
        controller.abort()
        await startup?.catch(() => {})
        started = false
        await client.stop()
      })
      const start = async (): Promise<void> => {
        if (started) return
        if (startup) return startup
        startup = (async () => {
          await client.start(controller.signal)
          controller.signal.throwIfAborted()
          started = true
        })().finally(() => { startup = undefined })
        return startup
      }
      const service: ClientService = {
        start,
        stop: async () => {
          started = false
          await client.stop()
        },
        connect: async (connection, signal) => {
          const previous = client.info()
          const combinedSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
          const info = await client.connect(connection, combinedSignal)
          if (!previous.remote || previous.clientId !== info.clientId) {
            const status = client.status()
            await emitEvent(ctx, nano.wake, { event: fromClientLifecycle("connected", status.workspace, status.capabilities, info.clientId) })
          }
          return info
        },
        disconnect: async () => {
          const previous = client.status()
          const wasRemote = client.info().remote
          const info = await client.disconnect()
          if (wasRemote && !info.remote) {
            await emitEvent(ctx, nano.wake, { event: fromClientLifecycle("disconnected", previous.workspace, previous.capabilities, previous.clientId) })
          }
          return info
        },
        info: () => client.info(),
        status: () => client.status(),
        getCapabilities: () => client.getCapabilities(),
        getWorkspace: () => client.getWorkspace(),
        execute: (input) => client.execute(input),
        capabilities: () => client.getCapabilities(),
        workspace: () => client.getWorkspace(),
        readFile: (path, maxBytes, timeoutMs) => readClientFile(client, path, maxBytes, timeoutMs, options.agentId?.trim() || undefined),
      }
      ctx.provide(nano.client.name, service)
      await start()
    },
  }
}
