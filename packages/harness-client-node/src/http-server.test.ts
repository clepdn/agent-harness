import assert from "node:assert/strict"
import test from "node:test"
import type { ClientToolHost } from "@nano/harness-core"
import type { ClientToolResult, ToolCapability, ToolInvocation, WorkspaceDescriptor } from "@nano/harness-protocol"
import { ToolClientHttpServer } from "./http-server.js"

class FakeHost implements ClientToolHost {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getCapabilities(): ToolCapability[] { return ["shell"] }
  getWorkspace(): WorkspaceDescriptor { return { id: "test", root: "/workspace" } }
  async execute(invocation: ToolInvocation): Promise<ClientToolResult> {
    return {
      type: "tool.result",
      invocationId: invocation.invocationId,
      agentId: invocation.agentId,
      status: "ok",
      output: String(invocation.args.command ?? ""),
      completedAt: new Date().toISOString(),
    }
  }
}

test("client serves health and tools without authentication", async () => {
  const server = new ToolClientHttpServer({ host: new FakeHost(), listenHost: "127.0.0.1", port: 0 })
  const address = await server.start()
  try {
    const health = await fetch(`${address.url}/health`)
    assert.equal(health.status, 200)
    assert.deepEqual((await health.json() as { capabilities: string[] }).capabilities, ["shell"])

    const invocation: ToolInvocation = {
      type: "tool.call",
      invocationId: "one",
      agentId: "mira",
      tool: "shell",
      args: { command: "hello" },
      issuedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    }
    const response = await fetch(`${address.url}/tools/shell`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(invocation),
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { output: string }).output, "hello")
  } finally {
    await server.stop()
  }
})

test("client streams incremental tool output as NDJSON when requested", async () => {
  class StreamingHost extends FakeHost {
    override async execute(
      invocation: ToolInvocation,
      _signal?: AbortSignal,
      onOutput?: (chunk: string) => void,
    ): Promise<ClientToolResult> {
      onOutput?.("alpha")
      await new Promise((resolve) => setTimeout(resolve, 10))
      onOutput?.("beta")
      return super.execute(invocation)
    }
  }

  const server = new ToolClientHttpServer({ host: new StreamingHost(), listenHost: "127.0.0.1", port: 0 })
  const address = await server.start()
  try {
    const invocation: ToolInvocation = {
      type: "tool.call",
      invocationId: "stream-one",
      agentId: "mira",
      tool: "shell",
      args: { command: "done" },
      issuedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    }
    const response = await fetch(`${address.url}/tools/shell`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify(invocation),
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /application\/x-ndjson/)
    const records = (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
    assert.deepEqual(records.slice(0, 2), [
      { type: "tool.output", output: "alpha" },
      { type: "tool.output", output: "beta" },
    ])
    assert.equal(records[2]?.type, "tool.result")
    assert.equal(records[2]?.result.output, "done")
  } finally {
    await server.stop()
  }
})

test("client with authToken rejects requests missing or mismatching the bearer token", async () => {
  const server = new ToolClientHttpServer({ host: new FakeHost(), listenHost: "127.0.0.1", port: 0, authToken: "s3cret" })
  const address = await server.start()
  try {
    // no header
    const noHeader = await fetch(`${address.url}/health`)
    assert.equal(noHeader.status, 401)

    // wrong scheme
    const basic = await fetch(`${address.url}/health`, { headers: { authorization: "Basic s3cret" } })
    assert.equal(basic.status, 401)

    // wrong token
    const wrong = await fetch(`${address.url}/health`, { headers: { authorization: "Bearer nope" } })
    assert.equal(wrong.status, 401)

    // correct token
    const ok = await fetch(`${address.url}/health`, { headers: { authorization: "Bearer s3cret" } })
    assert.equal(ok.status, 200)
  } finally {
    await server.stop()
  }
})

test("disconnecting a tool request aborts the host invocation", async () => {
  let resolveAborted!: () => void
  const aborted = new Promise<void>((resolve) => { resolveAborted = resolve })
  class BlockingHost extends FakeHost {
    override async execute(invocation: ToolInvocation, signal?: AbortSignal): Promise<ClientToolResult> {
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
      resolveAborted()
      return {
        type: "tool.result",
        invocationId: invocation.invocationId,
        agentId: invocation.agentId,
        status: "cancelled",
        completedAt: new Date().toISOString(),
      }
    }
  }

  const server = new ToolClientHttpServer({ host: new BlockingHost(), listenHost: "127.0.0.1", port: 0 })
  const address = await server.start()
  try {
    const invocation: ToolInvocation = {
      type: "tool.call",
      invocationId: "interrupt-me",
      agentId: "mira",
      tool: "shell",
      args: { command: "sleep 10" },
      issuedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    }
    const controller = new AbortController()
    const request = fetch(`${address.url}/tools/shell`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(invocation),
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 50)
    await assert.rejects(request)
    await aborted
  } finally {
    await server.stop()
  }
})
