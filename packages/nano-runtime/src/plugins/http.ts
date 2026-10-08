import type { Plugin } from "@nano/plugins"
import { createServer } from "../server"
import { nano } from "./api"

export interface HttpPluginConfig {
  readonly port: number
  readonly host: string
}

export function createHttpPlugin(defaults: HttpPluginConfig): Plugin<HttpPluginConfig> {
  return {
    id: "nano.http",
    requires: [nano.rpcAuth],
    validate(raw) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("nano.http config must be an object")
      const input = raw as Partial<HttpPluginConfig>
      const port = input.port ?? defaults.port
      const host = input.host ?? defaults.host
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("nano.http port must be an integer from 0 to 65535")
      if (typeof host !== "string" || !host.trim()) throw new TypeError("nano.http host must be a non-empty string")
      return { port, host }
    },
    async apply(scope, options) {
      const server = createServer({
        rpcGateway: {
          auth: () => scope.use(nano.rpcAuth),
          operations: () => scope.list(nano.operations),
          streams: () => scope.list(nano.streams),
        },
      })
      scope.own(async () => { await server.close() })
      await server.listen(options)
      scope.signal.throwIfAborted()
      console.log(`[nano] listening at ${server.listeningOrigin}`)
    },
  }
}
