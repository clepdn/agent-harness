import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createControlApplication } from "./application"
import { staticUiPlugin } from "@nano/plugin-control-static-ui"

test("control HTTP follows static UI arrival, withdrawal, and replacement", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nano-control-plugin-"))
  const firstDirectory = path.join(directory, "first")
  const secondDirectory = path.join(directory, "second")
  fs.mkdirSync(firstDirectory)
  fs.mkdirSync(secondDirectory)
  fs.writeFileSync(path.join(firstDirectory, "index.html"), "<main>first UI</main>")
  fs.writeFileSync(path.join(firstDirectory, "app.js"), "first asset")
  fs.writeFileSync(path.join(secondDirectory, "index.html"), "<main>second UI</main>")
  const application = await createControlApplication({
    config: {},
    controlPort: 0,
    databasePath: path.join(directory, "control.db"),
    agentDirectory: directory,
    webDistDir: path.join(directory, "not-built"),
  })
  t.after(async () => {
    await application.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const request = (url: string) => application.server.inject({ method: "GET", url })
  assert.equal((await request("/ui")).statusCode, 503)
  await application.fibers.get("control.static-ui")!.dispose()
  const first = await application.ctx.plugin(staticUiPlugin({ directory: firstDirectory }), { directory: firstDirectory, enabled: true })
  assert.equal((await request("/ui")).body, "<main>first UI</main>")
  assert.equal((await request("/ui/app.js")).body, "first asset")
  await first.dispose()
  assert.equal((await request("/ui")).statusCode, 503)
  assert.equal((await request("/ui/app.js")).statusCode, 503)
  await application.ctx.plugin(staticUiPlugin({ directory: secondDirectory }), { directory: secondDirectory, enabled: true })
  assert.equal((await request("/ui")).body, "<main>second UI</main>")
})
