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

test("control routes accept remote clients by default without permissive CORS", async (t) => {
  const directory = temporaryDirectory(t)
  const application = await createControlApplication({ config: {}, controlPort: 0, databasePath: path.join(directory, "control.db"), agentDirectory: directory })
  try {
    assert.equal((await application.server.inject({ method: "GET", url: "/health" })).statusCode, 200)
    const agents = await application.server.inject({ method: "GET", url: "/agents" })
    assert.equal(agents.statusCode, 200)
    assert.equal(agents.headers["access-control-allow-origin"], undefined)
    assert.equal((await application.server.inject({ method: "GET", url: "/unknown" })).statusCode, 404)
    const remote = { remoteAddress: "192.0.2.10", headers: { host: "control.example", origin: "https://control.example" } }
    assert.equal((await application.server.inject({ method: "GET", url: "/agents", ...remote })).statusCode, 200)
    const rpc = await application.server.inject({ method: "POST", url: "/rpc/control.agents.list", payload: { input: {} }, ...remote })
    assert.equal(rpc.statusCode, 200)
    assert.deepEqual(rpc.json(), { value: { agents: [] } })
  } finally {
    await application.close()
  }
})

test("explicit local-open mode still restricts remote clients", async (t) => {
  const directory = temporaryDirectory(t)
  const application = await createControlApplication({
    config: { plugins: { "nano.rpc-auth": { config: { mode: "local-open" } } } },
    controlPort: 0,
    databasePath: path.join(directory, "control.db"),
    agentDirectory: directory,
  })
  try {
    const remote = { remoteAddress: "192.0.2.10", headers: { host: "control.example" } }
    assert.equal((await application.server.inject({ method: "GET", url: "/agents", ...remote })).statusCode, 401)
    assert.equal((await application.server.inject({ method: "POST", url: "/rpc/control.agents.list", payload: { input: {} }, ...remote })).statusCode, 401)
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
    const rpcAuthorized = await application.server.inject({ method: "POST", url: "/rpc/control.agents.list", remoteAddress: "192.0.2.10", headers: { host: "control.example", origin: "https://control.example", authorization: "Bearer test-token" }, payload: { input: {} } })
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
    const operations = application.fibers.get("control.operations")
    assert.ok(operations)
    await operations.dispose()
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
