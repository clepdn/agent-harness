import type { Plugin } from "@nano/plugins"
import type { ClientService } from "./api"
import { nano } from "./api"
import { createConfiguredToolClient, readClientFile } from "../client"
import type { ConfiguredToolClientOptions } from "../client"
import { fromClientLifecycle } from "../triggers/client"

export type ClientPluginOptions = ConfiguredToolClientOptions

/** Install the configured client executor as a generation-owned runtime service. */
export function clientPlugin(options: ClientPluginOptions = {}): Plugin {
  return {
    id: "nano.client",
    provides: [nano.client],
    async apply(scope) {
      const client = createConfiguredToolClient(options)
      let disposed = false
      let started = false
      const service: ClientService = {
        start: scope.guard(async () => {
          if (started) return
          await client.start(scope.signal)
          if (scope.signal.aborted || disposed) {
            await client.stop()
            scope.signal.throwIfAborted()
            throw new Error("client plugin stopped during startup")
          }
          started = true
        }),
        stop: scope.guard(async () => {
          started = false
          await client.stop()
        }),
        connect: scope.guard(async (connection, signal) => {
          const previous = client.info()
          const combinedSignal = signal ? AbortSignal.any([scope.signal, signal]) : scope.signal
          const info = await client.connect(connection, combinedSignal)
          if (!previous.remote || previous.clientId !== info.clientId) {
            const status = client.status()
            await scope.emit(nano.wake, { event: fromClientLifecycle("connected", status.workspace, status.capabilities, info.clientId) })
          }
          return info
        }),
        disconnect: scope.guard(async () => {
          const previous = client.status()
          const wasRemote = client.info().remote
          const info = await client.disconnect()
          if (wasRemote && !info.remote) {
            await scope.emit(nano.wake, { event: fromClientLifecycle("disconnected", previous.workspace, previous.capabilities, previous.clientId) })
          }
          return info
        }),
        info: scope.guard(() => client.info()),
        status: scope.guard(() => client.status()),
        getCapabilities: scope.guard(() => client.getCapabilities()),
        getWorkspace: scope.guard(() => client.getWorkspace()),
        execute: scope.guard((input) => client.execute(input)),
        capabilities: scope.guard(() => client.getCapabilities()),
        workspace: scope.guard(() => client.getWorkspace()),
        readFile: scope.guard((path, maxBytes, timeoutMs) => readClientFile(client, path, maxBytes, timeoutMs, options.agentId?.trim() || undefined)),
      }
      scope.provide(nano.client, service)
      let startup: Promise<void> | undefined
      let cleanup: Promise<void> | undefined
      const stop = (): Promise<void> => {
        if (cleanup) return cleanup
        disposed = true
        cleanup = (async () => {
          await startup?.catch(() => {})
          started = false
          await client.stop()
        })()
        return cleanup
      }
      scope.own(stop)
      startup = service.start()
      await startup
      return stop
    }
  }
}
