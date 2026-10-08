import { Contributions } from "@nano/plugins"
import { createWebUI } from "@nano/web-api"
import { builtInWebPlugin } from "@nano/plugin-web-builtins"
import { createWebObserverPlugin } from "@nano/plugin-web-observer"

export const webUI = createWebUI()

export const webUiReady = (async () => {
  await webUI.ctx.plugin(Contributions)
  await webUI.ctx.plugin(builtInWebPlugin)
  await webUI.ctx.plugin(createWebObserverPlugin({ onChange: webUI.notifyChanged }))
})()
