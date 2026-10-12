import type { CordisContext, Plugin } from "@nano/plugins"
import { createServer } from "./server"
import { configSchema, getService, listContributions, nano } from "@nano/runtime-api"
import { nanoHttpRoutes } from "@nano/runtime-api/http"

export interface HttpPluginConfig {
  readonly port: number
  readonly host: string
}

export function createHttpPlugin(defaults: HttpPluginConfig): Plugin<HttpPluginConfig> {
  return {
    name: "nano.http",
    inject: [nano.rpcAuth.name, "nano.contributions"],
    Config: configSchema((raw) => {
      const input = (raw ?? {}) as Partial<HttpPluginConfig>
      const port = input.port ?? defaults.port
      const host = input.host ?? defaults.host
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("nano.http port must be an integer from 0 to 65535")
      if (typeof host !== "string" || !host.trim()) throw new TypeError("nano.http host must be a non-empty string")
      return { port, host }
    }),
    async apply(ctx: CordisContext, options: HttpPluginConfig) {
      const server = createServer({
        rpcGateway: {
          auth: () => getService(ctx, nano.rpcAuth),
          operations: () => listContributions(ctx, nano.operations),
          streams: () => listContributions(ctx, nano.streams),
        },
      })
      for (const installer of listContributions(ctx, nanoHttpRoutes)) await installer.value(server)
      await server.listen(options)
      console.log(`[nano] listening at ${server.listeningOrigin}`)
      return async () => { await server.close() }
    },
  }
}
export { createServer }
