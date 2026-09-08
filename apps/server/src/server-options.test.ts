import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { controlServerOptions } from "./server-options"

function configFile(t: test.TestContext, contents: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nano-server-config-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, "config.toml")
  fs.writeFileSync(file, contents)
  return file
}

test("control server defaults to loopback", () => {
  assert.deepEqual(controlServerOptions([], {}), { host: "127.0.0.1", port: 3000 })
})

test("[server].listen controls the bind address", (t) => {
  const file = configFile(t, "[server]\nlisten = \"0.0.0.0\"\nport = 4100\n")
  assert.deepEqual(controlServerOptions(["--config", file], {}), { host: "0.0.0.0", port: 4100 })
})

test("CLI network flags override the config", (t) => {
  const file = configFile(t, "[server]\nlisten = \"0.0.0.0\"\nport = 4100\n")
  assert.deepEqual(
    controlServerOptions([`--config=${file}`, "--host", "::1", "--port", "4200"], {}),
    { host: "::1", port: 4200 },
  )
})

test("later config files override earlier files", (t) => {
  const first = configFile(t, "[server]\nlisten = \"127.0.0.1\"\nport = 4100\n")
  const second = configFile(t, "[server]\nlisten = \"::\"\n")
  assert.deepEqual(controlServerOptions(["-c", first, "-c", second], {}), { host: "::", port: 4100 })
})
