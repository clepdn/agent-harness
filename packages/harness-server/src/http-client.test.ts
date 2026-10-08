import assert from "node:assert/strict"
import test from "node:test"
import { HttpToolClient } from "./http-client.js"

test("cancelled health handshake rejects late success without publishing capabilities", async () => {
  let resolveResponse!: (response: Response) => void
  const response = new Promise<Response>((resolve) => { resolveResponse = resolve })
  const client = new HttpToolClient({
    agentId: "mira",
    endpoint: "http://client.example:3002",
    capabilities: [],
    fetchImpl: async () => response,
  })
  const controller = new AbortController()
  const handshake = client.start(controller.signal)
  const rejected = assert.rejects(handshake, /handshake cancelled/)
  controller.abort(new Error("handshake cancelled"))
  resolveResponse(Response.json({ capabilities: ["shell"], workspace: { id: "late", root: "/workspace" } }))
  await rejected
  assert.equal(client.status().connected, false)
  assert.deepEqual(client.getCapabilities(), [])
  assert.equal(client.getWorkspace(), null)
})


test("direct client calls need no token or pairing handshake", async () => {
  const requests: RequestInit[] = []
  const client = new HttpToolClient({
    agentId: "mira",
    endpoint: "http://client.example:3002",
    fetchImpl: async (_input, init) => {
      requests.push(init ?? {})
      const invocation = JSON.parse(String(init?.body)) as { invocationId: string; agentId: string }
      return Response.json({
        type: "tool.result",
        invocationId: invocation.invocationId,
        agentId: invocation.agentId,
        status: "ok",
        output: "hello",
        completedAt: new Date().toISOString(),
      })
    },
  })

  const result = await client.execute({ agentId: "mira", tool: "shell", args: { command: "printf hello" } })
  assert.equal(result.output, "hello")
  assert.equal(new Headers(requests[0]?.headers).has("authorization"), false)
  assert.equal(client.status().connected, true)
})

test("client with authToken sends Authorization: Bearer on tool calls", async () => {
  const requests: RequestInit[] = []
  const client = new HttpToolClient({
    agentId: "mira",
    endpoint: "http://client.example:3002",
    authToken: "s3cret",
    fetchImpl: async (_input, init) => {
      requests.push(init ?? {})
      const invocation = JSON.parse(String(init?.body)) as { invocationId: string; agentId: string }
      return Response.json({
        type: "tool.result",
        invocationId: invocation.invocationId,
        agentId: invocation.agentId,
        status: "ok",
        output: "hello",
        completedAt: new Date().toISOString(),
      })
    },
  })

  const result = await client.execute({ agentId: "mira", tool: "shell", args: { command: "printf hello" } })
  assert.equal(result.output, "hello")
  assert.equal(new Headers(requests[0]?.headers).get("authorization"), "Bearer s3cret")
})

test("client forwards incremental NDJSON output before returning the final result", async () => {
  let releaseFinal!: () => void
  const finalReady = new Promise<void>((resolve) => { releaseFinal = resolve })
  const encoder = new TextEncoder()
  const client = new HttpToolClient({
    agentId: "mira",
    endpoint: "http://client.example:3002",
    fetchImpl: async (_input, init) => {
      const invocation = JSON.parse(String(init?.body)) as { invocationId: string; agentId: string }
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "tool.output", output: "alpha" })}\n`))
          await finalReady
          controller.enqueue(encoder.encode(`${JSON.stringify({
            type: "tool.result",
            result: {
              type: "tool.result",
              invocationId: invocation.invocationId,
              agentId: invocation.agentId,
              status: "ok",
              output: "alpha",
              completedAt: new Date().toISOString(),
            },
          })}\n`))
          controller.close()
        },
      })
      return new Response(body, { headers: { "content-type": "application/x-ndjson" } })
    },
  })

  let observed = ""
  const running = client.execute({
    agentId: "mira",
    tool: "shell",
    args: { command: "printf alpha" },
    onOutput: (chunk) => { observed += chunk },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(observed, "alpha")
  releaseFinal()
  assert.equal((await running).output, "alpha")
})

test("caller abort signals cancel remote tool requests", async () => {
  const client = new HttpToolClient({
    agentId: "mira",
    endpoint: "http://client.example:3002",
    fetchImpl: async (_input, init) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
      throw new Error("unreachable")
    },
  })
  const controller = new AbortController()
  const running = client.execute({
    agentId: "mira",
    tool: "shell",
    args: { command: "sleep 10" },
    signal: controller.signal,
  })
  controller.abort(new Error("operator interrupt"))
  const result = await running
  assert.equal(result.status, "cancelled")
  assert.match(result.output ?? "", /operator interrupt/)
})
