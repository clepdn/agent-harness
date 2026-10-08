import { watchContributions, type CordisContext, type Plugin } from "@nano/plugins"
import { webActionSlot, webEventRendererSlot, webPanelSlot, webViewSlot } from "@nano/web-api"

export type WebObserverOptions = {
  onChange(): void
}

export function createWebObserverPlugin({ onChange }: WebObserverOptions): Plugin {
  return {
    name: "nano.web.observer",
    inject: ["nano.contributions"],
    apply(ctx: CordisContext) {
      watchContributions(ctx, webPanelSlot, onChange)
      watchContributions(ctx, webViewSlot, onChange)
      watchContributions(ctx, webEventRendererSlot, onChange)
      watchContributions(ctx, webActionSlot, onChange)
    },
  }
}
