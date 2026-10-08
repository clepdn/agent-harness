import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import type { Plugin } from "@nano/plugins"
import { createControlApplication } from "./application"
import { CONTROL_STATIC_UI, type ControlStaticUi } from "@nano/control-api"

test("control application accepts a static UI replacement and unloads it on close", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nano-control-plugin-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let disposed = false
  const replacement: Plugin = {
    name: "control.static-ui",
    apply(ctx) {
      const service: ControlStaticUi = {
        enabled: true,
        directory,
        async serve(_relativePath, reply) {
          return reply.type("text/plain").send("replacement-ui")
        },
      }
      ctx.provide(CONTROL_STATIC_UI.name, service)
      ctx.effect(() => () => { disposed = true })
    },
  }
  const application = await createControlApplication({
    config: {},
    controlPort: 0,
    databasePath: path.join(directory, "control.db"),
    agentDirectory: directory,
    plugins: [replacement],
  })
  assert.equal((await application.server.inject({ method: "GET", url: "/ui" })).body, "replacement-ui")
  await application.close()
  assert.equal(disposed, true)
})
