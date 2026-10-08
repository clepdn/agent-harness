import { configSchema, type Plugin } from "@nano/plugins"
import { nanoRpcAuth, parseRpcAuthConfig, type RpcAuthConfig, type RpcAuthService } from "@nano/protocol/rpc"

export const controlRpcAuthPlugin: Plugin.Object<RpcAuthConfig> = {
  name: "nano.rpc-auth",
  provide: [nanoRpcAuth.name],
  Config: configSchema(parseRpcAuthConfig),
  apply(ctx, value) {
    const auth: RpcAuthService = {
      mode: value.mode,
      ...(value.token ? { token: value.token } : {}),
      allowedOrigins: value.allowedOrigins ?? [],
      permissions: value.permissions ?? [],
    }
    ctx.provide(nanoRpcAuth.name, auth)
  },
}
