import assert from "node:assert/strict"
import test from "node:test"
import { compactEventsForChat, compactWorkerEventForChat } from "./plugins"

function event(
  id: string,
  seq: number,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    agentId: "test-agent",
    seq,
    type: "conversation.message",
    createdAt: "2026-09-20T12:00:00.000Z",
    payload,
  }
}

test("chat projection keeps every tool call from a tool-only assistant message", () => {
  const toolCalls = [
    { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "one.txt" } },
    { type: "toolCall", id: "call-2", name: "shell", arguments: { command: "pwd" } },
  ]

  const compact = compactWorkerEventForChat(event("assistant-1", 1, {
    role: "assistant",
    content: "",
    toolCalls,
    createdAt: "2026-09-20T12:00:01.000Z",
  }))

  assert.ok(compact)
  assert.deepEqual(compact.payload, {
    role: "assistant",
    content: "",
    toolCalls,
    createdAt: "2026-09-20T12:00:01.000Z",
  })
})

test("chat projection keeps tool results and their call ids", () => {
  const compact = compactEventsForChat([
    event("result-1", 2, {
      role: "toolResult",
      content: "file contents",
      toolCallId: "call-1",
      createdAt: "2026-09-20T12:00:02.000Z",
    }),
  ])

  assert.equal(compact.length, 1)
  assert.deepEqual(compact[0]?.payload, {
    role: "toolResult",
    content: "file contents",
    toolCallId: "call-1",
    createdAt: "2026-09-20T12:00:02.000Z",
  })
})
