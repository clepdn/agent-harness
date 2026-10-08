import type { Plugin } from "@nano/plugins"
import { parseRpcAuthConfig } from "@nano/protocol/rpc"
import type { RpcAuthConfig, RpcAuthService } from "@nano/protocol/rpc"
import { nano } from "./api"

export const rpcAuthPlugin: Plugin<RpcAuthConfig> = {
  id: "nano.rpc-auth",
  provides: [nano.rpcAuth],
  validate(raw) {
    return parseRpcAuthConfig(raw ?? { mode: "local-open" })
  },
  apply(scope, config) {
    const auth: RpcAuthService = {
      mode: config.mode,
      ...(config.token === undefined ? {} : { token: config.token }),
      permissions: Object.freeze([...(config.permissions ?? [])]),
      allowedOrigins: Object.freeze([...(config.allowedOrigins ?? [])]),
    }
    return scope.provide(nano.rpcAuth, Object.freeze(auth))
  },
}
