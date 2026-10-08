import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "@nano/runtime-api/llm"
import type { AssistantMessage, Model, Tool } from "@nano/runtime-api/llm"
import { assistantContentText } from "./loop-content"
import { messageStringContent } from "./messages"
import { applyUsage, configuredSummaryProvider } from "./loop-completion"
import { getCompletionTools } from "@nano/plugin-tools"
import type { LoopState } from "@nano/runtime-api/contracts/runner"
import type { RuntimeModelConfig } from "@nano/runtime-api/contracts/model"

const fallbackModel: Model = {
  id: "fallback-fixture",
  name: "fallback-fixture",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://fixture.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
}

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
  const state = {
    tokenCount: 0,
    contextSize: 0,
    context: new Context({ model: fallbackModel }),
  } as unknown as LoopState
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

test("configured summary preference bypasses prompt-cache suppression without falling back", () => {
  const summaryState: RuntimeModelConfig = {
    primaryModel: fallbackModel, primaryApiKey: undefined, primaryToolChoice: "auto", primaryVision: false,
    primaryNudgeOnNoTool: false, idleCompactionMs: 0, cacheWarming: false, cacheWarmingDurationMs: 0,
    cacheWarmingMode: "completion", cacheLifetimeMs: 0, enableThinking: false, thinkingEffort: "low",
    fallbackModel, fallbackApiKey: undefined, fallbackToolChoice: "auto", summaryModel: fallbackModel,
    summaryApiKey: "summary-key", respectPromptCache: true, compactionStrategy: "off",
    compactTriggerTokens: 0, deepArchive: false, useFallback: false,
  }
  const state = { runtimeKind: "main" as const, services: { model: { current: () => summaryState } } } as unknown as LoopState
  assert.equal(configuredSummaryProvider("default", state).model, null)
  assert.deepEqual(configuredSummaryProvider("configured", state), { model: fallbackModel, apiKey: "summary-key" })
})

test("completion context preserves only the explicitly supplied dynamic tools", () => {
  const completionTools = getCompletionTools([
    {
      type: "function",
      function: {
        name: "memory_write",
        description: "Write memory",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_read",
        description: "Read memory",
        parameters: { type: "object", properties: {} },
      },
    },
  ])
  const names = (completionTools as Tool[]).map((tool) => tool.name)

  assert.equal(names.includes("memory_write"), true)
  assert.equal(names.includes("memory_read"), true)
  assert.equal(names.includes("wait"), false)
  assert.equal(new Set(names).size, names.length)
})

test("completion context does not reopen dynamically gated Discord tools", () => {
  const names = (getCompletionTools([
    {
      type: "function",
      function: {
        name: "memory_read",
        description: "Read memory",
        parameters: { type: "object", properties: {} },
      },
    },
  ]) as Tool[]).map((tool) => tool.name)

  assert.equal(names.includes("memory_read"), true)
  assert.equal(names.includes("discord_send"), false)
  assert.equal(names.includes("discord_upload"), false)
})
