import assert from "node:assert/strict"
import test from "node:test"
import { fallbackModel } from "./config"
import { messageStringContent } from "./messages"
import { proactiveCompaction } from "./summarize"
import { makeAssistantMessage, makeToolResultMessage } from "./test-helpers"

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
