import { Contributions } from "@nano/plugins"
import { builtInWebPlugin } from "@nano/plugin-web-builtins"
import { createWebObserverPlugin, createWebUI } from "@nano/plugin-web-observer"

export const webUI = createWebUI()

export const webUiReady = (async () => {
  await webUI.ctx.plugin(Contributions)
  await webUI.ctx.plugin(builtInWebPlugin)
  await webUI.ctx.plugin(createWebObserverPlugin({ onChange: webUI.notifyChanged }))
})()
