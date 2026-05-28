import assert from "node:assert/strict"
import test from "node:test"
import type { Message } from "../types"
import {
  AGENT_NAME,
  isContentFilterError,
  isImageParseError,
  shouldFallback,
  isPromptTooLargeError,
  restForestFromMessages,
  sanitizeMessages,
  scrubImagesFromConversation,
  buildContext,
  fromAssistantMessage,
  fromUsage,
} from "./util"
import type { AssistantMessage } from "@earendil-works/pi-ai"

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

// ── buildContext ──────────────────────────────────────────────────────────────

test("buildContext extracts system messages into systemPrompt", () => {
  const messages: Message[] = [
    { role: "system", content: "you are niri" },
    { role: "user", content: "hello" },
  ]
  const ctx = buildContext(messages, [])
  assert.equal(ctx.systemPrompt, "you are niri")
  assert.equal(ctx.messages.length, 1)
  assert.equal(ctx.messages[0]?.role, "user")
})

test("buildContext converts assistant tool calls", () => {
  const messages: Message[] = [
    {
      role: "assistant",
      content: "ok",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: '{"command":"ls"}' } }],
    } as Message,
  ]
  const ctx = buildContext(messages, [])
  const aMsg = ctx.messages[0] as { role: string; content: Array<{ type: string; id?: string; name?: string; arguments?: unknown }> }
  assert.equal(aMsg.role, "assistant")
  const toolCall = aMsg.content.find((p) => p.type === "toolCall") as { type: string; name?: string; arguments?: unknown } | undefined
  assert.ok(toolCall)
  assert.equal(toolCall?.name, "shell")
  assert.deepEqual(toolCall?.arguments, { command: "ls" })
})

test("buildContext converts tool result messages", () => {
  const messages: Message[] = [
    { role: "tool", tool_call_id: "call_1", content: "output text" } as Message,
  ]
  const ctx = buildContext(messages, [])
  const tr = ctx.messages[0] as { role: string; toolCallId: string; content: Array<{ text?: string }> }
  assert.equal(tr.role, "toolResult")
  assert.equal(tr.toolCallId, "call_1")
  assert.equal(tr.content[0]?.text, "output text")
})

// ── fromAssistantMessage ──────────────────────────────────────────────────────

test("fromAssistantMessage converts text + thinking + tool call", () => {
  const piMsg: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hmm..." },
      { type: "text", text: "hello" },
      { type: "toolCall", id: "call_1", name: "shell", arguments: { command: "ls" } },
    ],
    api: "openai-completions",
    provider: "openai",
    model: "test",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  }

  const result = fromAssistantMessage(piMsg)
  assert.equal(result.content, "hello")
  assert.equal(result.reasoning_content, "hmm...")
  assert.equal(result.tool_calls?.length, 1)
  const tc0 = result.tool_calls?.[0] as { function?: { name: string; arguments: string } } | undefined
  assert.equal(tc0?.function?.name, "shell")
  assert.equal(tc0?.function?.arguments, JSON.stringify({ command: "ls" }))
})

// ── fromUsage ─────────────────────────────────────────────────────────────────

test("fromUsage maps pi-ai usage to OAI CompletionUsage", () => {
  const usage = fromUsage({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })
  assert.equal(usage.prompt_tokens, 100)
  assert.equal(usage.completion_tokens, 50)
  assert.equal(usage.total_tokens, 150)
})

// ── sanitizeMessages ──────────────────────────────────────────────────────────

test("sanitizeMessages repairs orphaned tool responses", () => {
  const messages: Message[] = [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{}" } }],
    } as unknown as Message,
    // tool response missing — should be synthesized
  ]

  const repaired = sanitizeMessages(messages)
  assert.equal(repaired.length, 2)
  assert.equal(repaired[1]?.role, "tool")
})

// ── scrubImagesFromConversation ───────────────────────────────────────────────

test("scrubImagesFromConversation replaces image parts with placeholder text", () => {
  const conversation: Message[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image_url", image_url: { url: "https://cdn.example/pic.png" } },
      ],
    } as unknown as Message,
  ]

  const scrubbed = scrubImagesFromConversation(conversation)
  assert.equal(scrubbed, 1)
  const parts = (conversation[0] as unknown as { content: Array<{ type: string; text?: string }> }).content
  assert.equal(parts.length, 2)
  assert.equal(parts[1]!.type, "text")
  assert.ok(parts[1]!.text?.includes("rejected"))
})

// ── restForestFromMessages ────────────────────────────────────────────────────

test("restForestFromMessages returns the llm context summary", () => {
  const messages: Message[] = [
    { role: "system", content: "soul and core bootstrap" },
    { role: "user", content: "[wake]\n\nhello" },
    { role: "user", content: "[context summary v1]\n[llm-summary now]\nThread: project\n- carried forward" },
    { role: "assistant", content: "recent turn" },
  ]

  const forest = restForestFromMessages(messages)
  assert.match(forest, /^\[context summary v1\]/)
  assert.match(forest, /Thread: project/)
})
