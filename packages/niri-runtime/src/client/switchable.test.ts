import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import type { AddressInfo } from "node:net"
import type { ClientToolResult } from "@mira/harness-protocol"
import { SwitchableToolClient } from "./switchable"
import type { ConfiguredToolClient } from "./index"

function fakeFallback(): ConfiguredToolClient {
  return {
    start: async () => {},
    stop: async () => {},
    getCapabilities: () => ["shell"],
    getWorkspace: () => ({ id: "local", root: "/repo" }),
    status: () => ({
      connected: true,
      agentId: "test",
      clientId: "local",
      capabilities: ["shell"],
      workspace: { id: "local", root: "/repo" },
      pendingInvocations: 0,
    }),
    execute: async (): Promise<ClientToolResult> => ({
      type: "tool.result",
      invocationId: "x",
      agentId: "test",
      status: "ok",
      output: "from-local",
      completedAt: new Date().toISOString(),
    }),
  }
}

/** Minimal HTTP server emulating a remote tool executor. */
async function fakeExecutor(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ capabilities: ["shell"], workspace: { id: "pwd", root } }))
      return
    }
    // Tool invocation → echo back the request's ids so the client accepts it.
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c as Buffer))
    req.on("end", () => {
      let invocationId = "y"
      let agentId = "test"
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        if (typeof body?.invocationId === "string") invocationId = body.invocationId
        if (typeof body?.agentId === "string") agentId = body.agentId
      } catch {}
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          type: "tool.result",
          invocationId,
          agentId,
          status: "ok",
          output: "from-remote",
          completedAt: new Date().toISOString(),
        }),
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  }
}

test("defaults to the fallback client", async () => {
  const sw = new SwitchableToolClient("test", fakeFallback())
  await sw.start()
  assert.equal(sw.info().remote, false)
  assert.deepEqual(sw.getWorkspace(), { id: "local", root: "/repo" })
  await sw.stop()
})

test("connect mounts a remote executor and reverts on disconnect", async () => {
  const exec = await fakeExecutor("/home/callie/project")
  const sw = new SwitchableToolClient("test", fakeFallback())
  await sw.start()

  const info = await sw.connect({ endpoint: exec.url })
  assert.equal(info.remote, true)
  assert.equal(sw.getWorkspace()?.root, "/home/callie/project")

  const result = await sw.execute({ agentId: "test", tool: "shell", args: { command: "true" } })
  assert.equal(result.output, "from-remote")

  await sw.disconnect()
  assert.equal(sw.info().remote, false)
  assert.equal(sw.getWorkspace()?.root, "/repo")

  await sw.stop()
  await exec.close()
})

test("connect to an unreachable executor throws and keeps the fallback", async () => {
  const sw = new SwitchableToolClient("test", fakeFallback())
  await sw.start()
  await assert.rejects(() => sw.connect({ endpoint: "http://127.0.0.1:1" }))
  assert.equal(sw.info().remote, false)
  await sw.stop()
})
