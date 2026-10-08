import assert from "node:assert/strict"
import test from "node:test"
import type { Model } from "../llm"
import { messageStringContent } from "./messages"
import {
  buildConversationSummaryContent,
  buildConversationSummaryPrompt,
  proactiveCompaction,
} from "./summarize"
import { makeAssistantMessage, makeToolResultMessage, makeUserMessage } from "./test-helpers"

const fallbackModel: Model = {
  id: "summary-test",
  name: "Summary test",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://summary.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4096,
}

test("dedicated summarizer prompt requests a detailed operational play-by-play", () => {
  const prompt = buildConversationSummaryPrompt("grounding", "prior", true)
  assert.match(prompt, /detailed chronological play-by-play/i)
  assert.match(prompt, /Techniques that worked/)
  assert.match(prompt, /Techniques that failed/)
  assert.match(prompt, /People spoken to/)
  assert.match(prompt, /Highlights/)
  assert.match(prompt, /distinguish plans, attempts, verification, and completed outcomes/i)
  assert.match(prompt, /grounding/)
  assert.match(prompt, /prior/)
})

test("dedicated summary handoff includes the last summarized date and one-shot journal instruction", () => {
  const older = makeUserMessage("older")
  older.timestamp = Date.parse("2026-08-01T12:00:00.000Z")
  const latest = makeUserMessage("latest")
  latest.timestamp = Date.parse("2026-08-03T04:05:06.000Z")
  const content = buildConversationSummaryContent(
    "## Timeline\n- did the work",
    [older, latest],
    true,
    new Date("2026-08-04T00:00:00.000Z"),
  )
  assert.match(content, /\[summarized-through 2026-08-03T04:05:06\.000Z\]/)
  assert.match(content, /primary-model journal handoff/)
  assert.match(content, /journal this immediately/i)
  assert.match(content, /do not journal it again/i)
  assert.match(content, /## Timeline/)
})

test("proactive compaction attempts only one tool result per primary turn", async () => {
  const messages = [
    makeToolResultMessage("call-1", "read", "a".repeat(200)),
    makeAssistantMessage("first follow-up"),
    makeToolResultMessage("call-2", "read", "b".repeat(200)),
    makeAssistantMessage("second follow-up"),
  ]
  let requests = 0

  const result = await proactiveCompaction(messages, fallbackModel, undefined, 1, 100, async () => {
    requests++
    return "short useful summary"
  })

  assert.equal(requests, 1)
  assert.equal(result.attempted, 1)
  assert.equal(result.compacted, 1)
  assert.match(messageStringContent(result.messages[0]!), /^\[compacted\]/)
  assert.equal(messageStringContent(result.messages[2]!), "b".repeat(200))
})

test("proactive compaction does not retry a tool result that could not be reduced", async () => {
  const original = "large result ".repeat(20)
  const messages = [
    makeToolResultMessage("call-1", "read", original),
    makeAssistantMessage("follow-up"),
  ]
  let requests = 0
  const rejectSummary = async () => {
    requests++
    return null
  }

  const first = await proactiveCompaction(messages, fallbackModel, undefined, 1, 100, rejectSummary)
  const second = await proactiveCompaction(first.messages, fallbackModel, undefined, 1, 100, rejectSummary)

  assert.equal(requests, 1)
  assert.equal(first.attempted, 1)
  assert.equal(first.compacted, 0)
  assert.match(messageStringContent(first.messages[0]!), /^\[compaction attempted;/)
  assert.match(messageStringContent(first.messages[0]!), new RegExp(original.trim()))
  assert.equal(second.attempted, 0)
})
