import type { CordisContext, Plugin } from "@nano/plugins"
import { parseRpcAuthConfig } from "@nano/protocol/rpc"
import type { RpcAuthConfig, RpcAuthService } from "@nano/protocol/rpc"
import { configSchema, nano } from "@nano/runtime-api"

export const rpcAuthPlugin: Plugin<RpcAuthConfig> = {
  name: "nano.rpc-auth",
  provide: nano.rpcAuth.name,
  Config: configSchema((raw) => parseRpcAuthConfig(raw ?? { mode: "local-open" })),
  apply(ctx: CordisContext, config: RpcAuthConfig) {
    const auth: RpcAuthService = {
      mode: config.mode,
      ...(config.token === undefined ? {} : { token: config.token }),
      permissions: Object.freeze([...(config.permissions ?? [])]),
      allowedOrigins: Object.freeze([...(config.allowedOrigins ?? [])]),
    }
    ctx.provide(nano.rpcAuth.name, Object.freeze(auth))
  },
}
