import type { CordisContext, Plugin } from "@nano/plugins"

export type TuiRpcChatOptions = {
  abortController: AbortController
  chat: { close(): void }
}

export function createTuiRpcChatPlugin(options: TuiRpcChatOptions): Plugin {
  return {
    name: "nano.tui.rpc-chat",
    apply(ctx: CordisContext) {
      ctx.effect(() => () => {
        options.abortController.abort()
        options.chat.close()
      })
    },
  }
}
