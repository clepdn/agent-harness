import assert from "node:assert/strict"
import test from "node:test"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { assistantContentText } from "./loop-content"
import { messageStringContent } from "./messages"

// Pi AssistantMessage is the native format now — no conversion needed.
// These tests verify helper functions that work on pi types directly.

test("assistantContentText extracts text from pi content array", () => {
  const msg: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hmm..." },
      { type: "text", text: "hello" },
      { type: "toolCall", id: "call_1", name: "shell", arguments: { command: "ls" } },
    ],
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  }

  assert.equal(assistantContentText(msg.content), "hello")
})

test("assistantContentText returns empty string for content with no text parts", () => {
  const msg: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: "call_1", name: "shell", arguments: {} }],
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  }

  assert.equal(assistantContentText(msg.content), "")
})

test("messageStringContent returns text content for toolResult messages", () => {
  const msg = {
    role: "toolResult" as const,
    toolCallId: "call_1",
    toolName: "shell",
    content: [{ type: "text" as const, text: "hello from tool" }],
    isError: false,
    timestamp: Date.now(),
  }

  assert.equal(messageStringContent(msg), "hello from tool")
})
