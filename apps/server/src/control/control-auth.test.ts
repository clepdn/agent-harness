import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import WebSocket from "ws"
import { createControlApplication } from "./application"

function temporaryDirectory(t: test.TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nano-control-auth-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test("control routes are local-open by default without permissive CORS", async (t) => {
  const directory = temporaryDirectory(t)
  const application = await createControlApplication({ config: {}, controlPort: 0, databasePath: path.join(directory, "control.db"), agentDirectory: directory })
  try {
    assert.equal((await application.server.inject({ method: "GET", url: "/health" })).statusCode, 200)
    const agents = await application.server.inject({ method: "GET", url: "/agents" })
    assert.equal(agents.statusCode, 200)
    assert.equal(agents.headers["access-control-allow-origin"], undefined)
    assert.equal((await application.server.inject({ method: "GET", url: "/unknown" })).statusCode, 404)
  } finally {
    await application.close()
  }
})

test("control token mode protects legacy routes and RPC with the same bearer token", async (t) => {
  const directory = temporaryDirectory(t)
  const application = await createControlApplication({
    config: { plugins: { "nano.rpc-auth": { enabled: true, config: { mode: "token", token: "test-token", permissions: ["control.read", "control.write"] } } } },
    controlPort: 0,
    databasePath: path.join(directory, "control.db"),
    agentDirectory: directory,
  })
  try {
    assert.equal((await application.server.inject({ method: "GET", url: "/agents" })).statusCode, 401)
    const authorized = await application.server.inject({ method: "GET", url: "/agents", headers: { authorization: "Bearer test-token" } })
    assert.equal(authorized.statusCode, 200)
    const rpcDenied = await application.server.inject({ method: "POST", url: "/rpc/control.agents.list", payload: { input: {} } })
    assert.equal(rpcDenied.statusCode, 401)
    const rpcAuthorized = await application.server.inject({ method: "POST", url: "/rpc/control.agents.list", headers: { authorization: "Bearer test-token" }, payload: { input: {} } })
    assert.equal(rpcAuthorized.statusCode, 200)
    assert.deepEqual(JSON.parse(rpcAuthorized.body).value, { agents: [] })
  } finally {
    await application.close()
  }
})

test("legacy routes disappear when their selected operation exports are withdrawn", async (t) => {
  const directory = temporaryDirectory(t)
  const application = await createControlApplication({ config: {}, controlPort: 0, databasePath: path.join(directory, "control.db"), agentDirectory: directory })
  try {
    assert.equal((await application.server.inject({ method: "GET", url: "/agents" })).statusCode, 200)
    await application.bus.disable("control.operations")
    const withdrawn = await application.server.inject({ method: "GET", url: "/agents" })
    assert.equal(withdrawn.statusCode, 404)
  } finally {
    await application.close()
  }
})

test("token WebSocket RPC authenticates from its first auth frame", async (t) => {
  const directory = temporaryDirectory(t)
  const application = await createControlApplication({
    config: { plugins: { "nano.rpc-auth": { enabled: true, config: { mode: "token", token: "test-token", permissions: ["control.read"] } } } },
    controlPort: 0,
    databasePath: path.join(directory, "control.db"),
    agentDirectory: directory,
  })
  let socket: WebSocket | undefined
  try {
    await application.server.listen({ host: "127.0.0.1", port: 0 })
    const address = application.server.server.address()
    assert(address && typeof address === "object")
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/rpc/stream`)
    await new Promise<void>((resolve, reject) => {
      socket?.once("open", () => resolve())
      socket?.once("error", reject)
    })
    socket.send(JSON.stringify({ op: "auth", token: "test-token" }))
    const frame = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket?.once("message", (data) => {
        try { resolve(JSON.parse(data.toString()) as Record<string, unknown>) } catch (error) { reject(error) }
      })
      socket?.once("error", reject)
    })
    assert.deepEqual(frame, { op: "auth", ok: true })
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) socket.close()
    await application.close()
  }
})
