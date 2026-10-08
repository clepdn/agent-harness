import assert from "node:assert/strict"
import test from "node:test"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { listContributions, onEvent, type Plugin } from "@nano/plugins"
import { createServer } from "./server"
import { createExecutionServices, type TestExecutionFixture } from "./test-model-provider"
import { workerClientOperationsPlugin, workerOperationsPlugin } from "@nano/plugin-worker-operations"
import { createRunnerPlugin } from "@nano/plugin-runner"
import { nano } from "@nano/runtime-api"
import type { UserMessage } from "./types"

function lifecycleObserver(events: UserMessage[]): Plugin {
  return {
    name: "server-auth-observer",
    apply(ctx) {
      onEvent(ctx, nano.wake, ({ event }) => { events.push(event) })
    },
  }
}

async function installWorkerServices(fixture: TestExecutionFixture, events: UserMessage[]): Promise<void> {
  await fixture.ctx.plugin(lifecycleObserver(events))
  await fixture.ctx.plugin({
    name: "server-auth-lifecycle",
    apply(ctx) {
      ctx.provide(nano.lifecycle.name, { shutdown() {}, restart() {} })
    },
  })
  await fixture.ctx.plugin(createRunnerPlugin())
  await fixture.ctx.plugin(workerOperationsPlugin)
  await fixture.ctx.plugin(workerClientOperationsPlugin)
}

function gateway(fixture: TestExecutionFixture) {
  return {
    auth: () => ({ mode: "local-open" as const, allowedOrigins: [], permissions: ["*"] }),
    operations: () => listContributions(fixture.ctx, nano.operations),
    streams: () => listContributions(fixture.ctx, nano.streams),
  }
}

test("worker routes need no bearer token and do not enable permissive CORS", async () => {
  const fixture = await createExecutionServices()
  await installWorkerServices(fixture, [])
  const app = createServer({ rpcGateway: gateway(fixture) })
  try {
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200)
    const crossOriginHealth = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } })
    assert.equal(crossOriginHealth.headers["access-control-allow-origin"], undefined)
    assert.equal((await app.inject({ method: "GET", url: "/awp/status" })).statusCode, 200)
  } finally {
    await app.close()
    await fixture.close()
  }
})

test("client connect and disconnect routes dispatch lifecycle messages", async () => {
  const executor = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ clientId: "tui-client", capabilities: ["shell", "read_file"], workspace: { id: "tui", root: "/workspace" } }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => executor.listen(0, "127.0.0.1", resolve))
  const endpoint = `http://127.0.0.1:${(executor.address() as AddressInfo).port}`
  const events: UserMessage[] = []
  const fixture = await createExecutionServices()
  await installWorkerServices(fixture, events)
  const app = createServer({ rpcGateway: gateway(fixture) })
  try {
    const connected = await app.inject({ method: "POST", url: "/client/connect", payload: { endpoint } })
    assert.equal(connected.statusCode, 200)
    assert.equal(connected.json().notified, true)
    assert.equal(events.length, 1)
    assert.equal(events[0]?.source, "client")
    assert.deepEqual(events[0]?.raw, {
      type: "client.workspace.connected",
      workspace: { id: "tui", root: "/workspace" },
      capabilities: ["shell", "read_file"],
      clientId: endpoint,
    })
    assert.match(events[0]?.content ?? "", /workspace_root: \/workspace/)

    const disconnected = await app.inject({ method: "POST", url: "/client/disconnect" })
    assert.equal(disconnected.statusCode, 200)
    assert.equal(disconnected.json().notified, true)
    assert.equal(events.length, 2)
    assert.equal(events[1]?.source, "client")
    assert.deepEqual(events[1]?.raw, {
      type: "client.workspace.disconnected",
      workspace: { id: "tui", root: "/workspace" },
      capabilities: ["shell", "read_file"],
      clientId: endpoint,
    })
    assert.match(events[1]?.content ?? "", /workspace_root: \/workspace/)
  } finally {
    await app.close()
    await fixture.close()
    await new Promise<void>((resolve, reject) => executor.close((error) => error ? reject(error) : resolve()))
  }
})

test("failed client connection does not notify the agent", async () => {
  const events: UserMessage[] = []
  const fixture = await createExecutionServices()
  await installWorkerServices(fixture, events)
  const app = createServer({ rpcGateway: gateway(fixture) })
  try {
    const response = await app.inject({
      method: "POST",
      url: "/client/connect",
      payload: { endpoint: "http://127.0.0.1:1", workspace: { id: "tui", root: "/workspace" }, capabilities: ["shell"] },
    })
    assert.equal(response.statusCode, 502)
    assert.equal(events.length, 0)
    const status = await app.inject({ method: "GET", url: "/awp/client/status" })
    assert.equal(status.statusCode, 200)
    assert.equal(status.json().connected, fixture.services.client.status().connected)
    assert.equal(fixture.services.client.info().remote, false)
  } finally {
    await app.close()
    await fixture.close()
  }
})
