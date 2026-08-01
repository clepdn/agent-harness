import assert from "node:assert/strict"
import test from "node:test"
import type { AssistantMessage } from "../llm"
import { assistantContentText } from "./loop-content"
import { messageStringContent } from "./messages"
import { applyUsage } from "./loop-completion"

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

test("applyUsage counts cacheWrite tokens toward contextSize (regression)", () => {
  // Regression: contextSize was `input + cacheRead`, omitting cacheWrite. On any
  // turn that created/extended the prompt cache, the bulk of the prompt lands in
  // cache_creation (cacheWrite), so contextSize undercounted badly. It must be
  // input + cacheRead + cacheWrite (the full prompt-side token count).
  const state = {
    tokenCount: 0,
    contextSize: 0,
    conversation: [],
  } as unknown as import("./types").LoopState
  const usage = {
    input: 1000,
    output: 200,
    cacheRead: 5000,
    cacheWrite: 40000,
    totalTokens: 46200,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  applyUsage(state, usage)
  assert.equal(state.contextSize, 46000, "contextSize must be input + cacheRead + cacheWrite (not output)")
})
