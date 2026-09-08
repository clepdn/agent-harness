import assert from "node:assert/strict"
import test from "node:test"
import type { Message } from "../types"
import {
  isContentFilterError,
  isImageParseError,
  shouldFallback,
  isPromptTooLargeError,
  restSummaryFromMessages,
  sanitizeMessages,
  scrubImagesFromConversation,
} from "./util"

// ── Error detection (string-based) ───────────────────────────────────────────

test("shouldFallback returns true for 429 status in error message", () => {
  assert.equal(shouldFallback("429 Too Many Requests"), true)
})

test("shouldFallback returns true for 500 status in error message", () => {
  assert.equal(shouldFallback("500 Internal Server Error"), true)
})

test("shouldFallback returns false for 400 status in error message", () => {
  assert.equal(shouldFallback("400 Bad Request"), false)
})

test("shouldFallback returns true for transport error keywords", () => {
  assert.equal(shouldFallback("fetch failed: ECONNREFUSED"), true)
  assert.equal(shouldFallback("terminated"), true)
  assert.equal(shouldFallback("some unrelated error"), false)
})

test("shouldFallback returns true for request timeout", () => {
  assert.equal(shouldFallback("Request timed out."), true)
  assert.equal(shouldFallback("request timed out"), true)
})

test("isPromptTooLargeError detects context length phrases", () => {
  assert.equal(isPromptTooLargeError("context length exceeded"), true)
  assert.equal(isPromptTooLargeError("too many tokens in input"), true)
  assert.equal(isPromptTooLargeError("400 Bad Request"), false)
})

test("isImageParseError detects 1210 code and Chinese image phrases", () => {
  assert.equal(isImageParseError("1210 图片输入格式/解析错误"), true)
  assert.equal(isImageParseError("invalid image format"), true)
  assert.equal(isImageParseError("400 bad request"), false)
})

test("isContentFilterError detects content filter phrases", () => {
  assert.equal(isContentFilterError("content filter triggered"), true)
  assert.equal(isContentFilterError("potentially unsafe or sensitive content"), true)
  assert.equal(isContentFilterError("400 invalid request"), false)
})

// ── sanitizeMessages ──────────────────────────────────────────────────────────

test("sanitizeMessages repairs missing tool responses", () => {
  const messages: Message[] = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "shell", arguments: {} }],
      api: "openai-completions",
      provider: "openai",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
    // tool response missing — should be synthesized
  ]

  const repaired = sanitizeMessages(messages)
  assert.equal(repaired.length, 2)
  assert.equal(repaired[1]?.role, "toolResult")
})

test("sanitizeMessages rescues tool responses found after intervening messages", () => {
  const t = Date.now()
  const assistantMsg = {
    role: "assistant" as const,
    content: [
      { type: "toolCall" as const, id: "call_1", name: "shell", arguments: {} },
      { type: "toolCall" as const, id: "call_2", name: "shell", arguments: {} },
    ],
    api: "openai-completions",
    provider: "openai",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse" as const,
    timestamp: t,
  }
  // Only call_1 result is immediately after; call_2 is orphaned further down
  const messages: Message[] = [
    assistantMsg,
    { role: "toolResult", toolCallId: "call_1", toolName: "shell", content: [{ type: "text", text: "out1" }], isError: false, timestamp: t },
    { role: "user", content: "some other message", timestamp: t },
    { role: "toolResult", toolCallId: "call_2", toolName: "shell", content: [{ type: "text", text: "out2" }], isError: false, timestamp: t },
  ]

  const repaired = sanitizeMessages(messages)
  // call_2 result should be rescued and placed after call_1
  assert.equal(repaired.length, 4)
  assert.equal(repaired[1]?.role, "toolResult")
  assert.equal(repaired[2]?.role, "toolResult")
  assert.equal((repaired[2] as import("../llm").ToolResultMessage).toolCallId, "call_2")
})

// ── scrubImagesFromConversation ───────────────────────────────────────────────

test("scrubImagesFromConversation replaces image parts with placeholder text", () => {
  const conversation: Message[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", data: "abc123", mimeType: "image/jpeg" },
      ],
      timestamp: Date.now(),
    },
  ]

  const scrubbed = scrubImagesFromConversation(conversation)
  assert.equal(scrubbed, 1)
  const msg = conversation[0] as { content: Array<{ type: string; text?: string }> }
  assert.equal(msg.content.length, 2)
  assert.equal(msg.content[1]!.type, "text")
  assert.ok(msg.content[1]!.text?.includes("rejected"))
})

// ── restSummaryFromMessages ────────────────────────────────────────────────────

test("restSummaryFromMessages returns the llm context summary", () => {
  const messages: Message[] = [
    { role: "user", content: "[wake]\n\nhello", timestamp: Date.now() },
    { role: "user", content: "[context summary v1]\n[llm-summary now]\nThread: project\n- carried forward", timestamp: Date.now() },
    {
      role: "assistant",
      content: [{ type: "text", text: "recent turn" }],
      api: "openai-completions",
      provider: "openai",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ]

  const summary = restSummaryFromMessages(messages)
  assert.match(summary, /^\[context summary v1\]/)
  assert.match(summary, /Thread: project/)
})
