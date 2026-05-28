import assert from "node:assert/strict"
import test from "node:test"
import { fromAssistantMessage } from "./util"
import type { AssistantMessage } from "@earendil-works/pi-ai"

test("fromAssistantMessage converts text + thinking + tool calls to OAI format", () => {
  const piMsg: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "thinking..." },
      { type: "text", text: "hello" },
      {
        type: "toolCall",
        id: "call_1",
        name: "shell",
        arguments: { command: "ls" },
      },
    ],
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  }

  const result = fromAssistantMessage(piMsg)

  assert.equal(result.role, "assistant")
  assert.equal(result.content, "hello")
  assert.equal(result.reasoning_content, "thinking...")
  assert.equal(result.tool_calls?.length, 1)
  const tc0 = result.tool_calls?.[0] as { function: { name: string; arguments: string } } | undefined
  assert.equal(tc0?.function.name, "shell")
  assert.equal(tc0?.function.arguments, JSON.stringify({ command: "ls" }))
})

test("fromAssistantMessage handles empty content gracefully", () => {
  const piMsg: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  }

  const result = fromAssistantMessage(piMsg)
  assert.equal(result.content, null)
  assert.equal(result.tool_calls, undefined)
  assert.equal(result.reasoning_content, undefined)
})
