import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "./server"
import { fromClientLifecycle } from "./triggers/client"
import http from "node:http"
import type { AddressInfo } from "node:net"

test("worker routes need no bearer token and do not enable permissive CORS", async () => {
  const app = createServer()
  try {
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200)
    const crossOriginHealth = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } })
    assert.equal(crossOriginHealth.headers["access-control-allow-origin"], undefined)
    assert.equal((await app.inject({ method: "GET", url: "/awp/status" })).statusCode, 200)
  } finally {
    await app.close()
  }
})

test("client lifecycle messages describe the mounted workspace", () => {
  const connected = fromClientLifecycle("connected", { id: "tui", root: "/workspace" }, ["shell", "read_file"], "tui-client")
  assert.equal(connected.source, "client")
  assert.match(connected.content, /client workspace connected/)
  assert.match(connected.content, /workspace_root: \/workspace/)
  assert.match(connected.content, /capabilities: shell, read_file/)
  assert.equal(connected.clientId, "tui-client")

  const disconnected = fromClientLifecycle("disconnected", { id: "tui", root: "/workspace" }, ["shell"])
  assert.match(disconnected.content, /client workspace disconnected/)
  assert.deepEqual(disconnected.raw, {
    type: "client.workspace.disconnected",
    workspace: { id: "tui", root: "/workspace" },
    capabilities: ["shell"],
    clientId: undefined,
  })
})

test("client connect and disconnect routes dispatch lifecycle messages", async () => {
  const executor = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        capabilities: ["shell", "read_file"],
        workspace: { id: "tui", root: "/workspace" },
      }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => executor.listen(0, "127.0.0.1", resolve))
  const endpoint = `http://127.0.0.1:${(executor.address() as AddressInfo).port}`
  const events: import("./types").UserMessage[] = []
  const app = createServer({
    dispatchClientLifecycle: (event) => {
      events.push(event)
      return true
    },
  })
  try {
    const connected = await app.inject({ method: "POST", url: "/client/connect", payload: { endpoint } })
    assert.equal(connected.statusCode, 200)
    assert.equal(connected.json().notified, true)
    assert.match(events[0]?.content ?? "", /workspace connected/)
    assert.match(events[0]?.content ?? "", /workspace_root: \/workspace/)

    const disconnected = await app.inject({ method: "POST", url: "/client/disconnect" })
    assert.equal(disconnected.statusCode, 200)
    assert.equal(disconnected.json().notified, true)
    assert.match(events[1]?.content ?? "", /workspace disconnected/)
    assert.match(events[1]?.content ?? "", /workspace_root: \/workspace/)
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => executor.close((error) => error ? reject(error) : resolve()))
  }
})

test("failed client connection does not notify the agent", async () => {
  const events: import("./types").UserMessage[] = []
  const app = createServer({
    dispatchClientLifecycle: (event) => {
      events.push(event)
      return true
    },
  })
  try {
    const workspace = { id: "tui", root: "/workspace" }
    const connected = await app.inject({
      method: "POST",
      url: "/client/connect",
      payload: {
        endpoint: "http://127.0.0.1:1",
        workspace,
        capabilities: ["shell"],
      },
    })
    assert.equal(connected.statusCode, 502)
    assert.equal(events.length, 0)
  } finally {
    await app.close()
  }
})
