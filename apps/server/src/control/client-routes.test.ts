import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import test from "node:test"
import { createControlServer } from "./server"
import { initControlDb, upsertAgent } from "./db"

type WorkerRequest = {
  method: string
  path: string
  body: unknown
}

async function startWorker(requests: WorkerRequest[]): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const rawBody = Buffer.concat(chunks).toString("utf8")
    requests.push({
      method: req.method ?? "",
      path: req.url ?? "",
      body: rawBody ? JSON.parse(rawBody) : undefined,
    })

    res.setHeader("content-type", "application/json")
    if (req.url === "/client/connect") {
      res.end(JSON.stringify({ ok: true, connected: true }))
      return
    }
    if (req.url === "/client/disconnect") {
      res.end(JSON.stringify({ ok: true, disconnected: true }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: "not found" }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  assert(address && typeof address !== "string")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

test("control plane forwards client handshakes to the configured worker", async () => {
  initControlDb()
  const requests: WorkerRequest[] = []
  const worker = await startWorker(requests)
  const agentId = "client-route-test-agent"
  upsertAgent({ id: agentId, baseUrl: worker.url })
  const app = createControlServer({ configuredAgentIds: new Set([agentId]) })

  try {
    const connect = await app.inject({
      method: "POST",
      url: `/agents/${agentId}/client/connect`,
      payload: {
        endpoint: "http://127.0.0.1:4321",
        workspace: { root: "/tmp/workspace" },
        capabilities: ["shell"],
      },
    })
    assert.equal(connect.statusCode, 200)
    assert.deepEqual(JSON.parse(connect.body), { ok: true, connected: true })

    const disconnect = await app.inject({
      method: "POST",
      url: `/agents/${agentId}/client/disconnect`,
    })
    assert.equal(disconnect.statusCode, 200)
    assert.deepEqual(JSON.parse(disconnect.body), { ok: true, disconnected: true })

    assert.deepEqual(requests, [
      {
        method: "POST",
        path: "/client/connect",
        body: {
          endpoint: "http://127.0.0.1:4321",
          workspace: { root: "/tmp/workspace" },
          capabilities: ["shell"],
        },
      },
      { method: "POST", path: "/client/disconnect", body: undefined },
    ])
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => worker.server.close((error) => error ? reject(error) : resolve()))
  }
})

test("control plane returns 404 for an unknown client agent", async () => {
  initControlDb()
  const app = createControlServer({ configuredAgentIds: new Set(["configured-agent"]) })
  try {
    const response = await app.inject({
      method: "POST",
      url: "/agents/missing-agent/client/connect",
      payload: { endpoint: "http://127.0.0.1:4321" },
    })
    assert.equal(response.statusCode, 404)
    assert.deepEqual(JSON.parse(response.body), { error: "agent not found" })
  } finally {
    await app.close()
  }
})
