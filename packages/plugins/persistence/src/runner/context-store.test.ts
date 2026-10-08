import assert from "node:assert/strict"
import test from "node:test"
import { createDatabase } from "../db"
import type { Message } from "@nano/runtime-api/types"
import { attachContextSummaryId, contextSummaryId, createContextStore } from "./context-store"

const makeUserMessage = (content: string) => ({ role: "user" as const, content, timestamp: 1 })
const makeAssistantMessage = (content: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text: content }],
  api: "test", provider: "test", model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop" as const,
  timestamp: 1,
})

const database = createDatabase(":memory:").db
const contextStore = createContextStore(database)
test.after(() => database.close())

/** Archived rows store the whole original message under `content`; pull its inner content out. */
function sourceContent(message: { content: unknown }): unknown {
  const source = message.content
  if (source && typeof source === "object" && "content" in source) return source.content
  return source
}

test("immutable context archive preserves exact messages and supports literal search", () => {
  const marker = `lossless-search-${Date.now()}`
  const message = { role: "user", content: `the exact hidden detail is ${marker}` } as Message

  const [messageId] = contextStore.archiveContextMessages([message], "test-checkpoint")
  const results = contextStore.grepContext(marker, 5)

  assert.ok(messageId?.startsWith("msg_"))
  assert.equal(results.length, 1)
  assert.equal(results[0]?.messageId, messageId)
  assert.equal(results[0]?.content, message.content)
  assert.equal(results[0]?.source, "test-checkpoint")
})

test("summary DAG expands parent provenance before newer direct messages", () => {
  const first = makeUserMessage("first exact source message") as Message
  const second = makeAssistantMessage("second exact source message") as Message
  const third = makeUserMessage("third exact source message") as Message

  const parentId = contextStore.recordContextCompaction({
    summaryText: "parent summary",
    compactedMessages: [first, second],
    method: "test-parent",
  })
  const parentContent = `[context summary v1]\n[segments]\n[context-summary-id ${parentId}]\nparent summary`
  const childId = contextStore.recordContextCompaction({
    summaryText: "child summary",
    compactedMessages: [third],
    priorSummaryContent: parentContent,
    method: "test-child",
  })

  const expanded = contextStore.expandContextSummary(childId, 0, 10)
  assert.ok(expanded)
  assert.equal(expanded.totalMessages, 3)
  assert.deepEqual(
    expanded.messages.map(sourceContent),
    [first.content, second.content, third.content],
  )

  const scoped = contextStore.grepContext("first exact", 5, childId)
  assert.equal(scoped.length, 1)
})

test("lcm description exposes summary content, lineage, and bounded expansion costs", () => {
  const parentMessage = makeUserMessage("describe parent source") as Message
  const childMessage = makeAssistantMessage("describe child source") as Message
  const parentId = contextStore.recordContextCompaction({
    summaryText: "describe parent summary",
    compactedMessages: [parentMessage],
    method: "test-describe-parent",
  })
  const parentContent = `[context summary v1]\n[segments]\n[context-summary-id ${parentId}]\ndescribe parent summary`
  const childId = contextStore.recordContextCompaction({
    summaryText: "describe child summary",
    compactedMessages: [childMessage],
    priorSummaryContent: parentContent,
    method: "test-describe-child",
  })

  const described = contextStore.describeContextSummary(childId, 1)
  assert.ok(described)
  assert.equal(described.type, "summary")
  assert.equal(described.summary.content, "describe child summary")
  assert.deepEqual(described.summary.parentIds, [parentId])
  assert.equal(described.summary.provenanceDepth, 1)
  assert.equal(described.summary.provenanceNodeCount, 2)
  assert.equal(described.summary.directSources.messageCount, 1)
  assert.equal(described.summary.expandedSources.messageCount, 2)
  assert.equal(described.summary.manifest[0]?.summaryId, childId)
  assert.equal(described.summary.manifest[1]?.summaryId, parentId)
  assert.equal(described.summary.manifest[0]?.expansionFitsTokenCap, false)
  assert.equal(described.expansion.totalMessages, 2)
  assert.equal(described.expansion.defaultPageSize, 12)
  assert.equal(described.expansion.tokenCap, 1)
  assert.equal(contextStore.describeContextSummary("sum_missing"), null)
})

test("active summary messages carry a stable retrievable id", () => {
  const id = "sum_00000000-0000-4000-8000-000000000000"
  const messages = attachContextSummaryId([
    { role: "system", content: "bootstrap" },
    { role: "user", content: "[context summary v1]\n[segments]\nsummary text" },
  ] as Message[], id)

  assert.equal(contextSummaryId(String(messages[1]?.content)), id)
  assert.match(String(messages[1]?.content), /\[segments\]\n\[context-summary-id/)
})

test("summary provenance preserves repeated identical message occurrences", () => {
  const repeated = { role: "user", content: `repeated exact source ${Date.now()}` } as Message
  const summaryId = contextStore.recordContextCompaction({
    summaryText: "two repeated messages",
    compactedMessages: [repeated, repeated],
    method: "test-repetition",
  })
  const expanded = contextStore.expandContextSummary(summaryId, 0, 10)
  assert.ok(expanded)
  assert.equal(expanded.totalMessages, 2)
  assert.equal(expanded.messages[0]?.id, expanded.messages[1]?.id)
})

test("rest snapshot extends the current summary with the exact raw tail", () => {
  const oldSource = { role: "user", content: `older compacted message ${Date.now()}` } as Message
  const parentId = contextStore.recordContextCompaction({
    summaryText: "older living summary",
    compactedMessages: [oldSource],
    method: "test-before-rest",
  })
  const parentForest = String(attachContextSummaryId([
    makeUserMessage("[context summary v1]\n[segments]\nolder living summary") as Message,
  ], parentId)[0]?.content)
  const tail = [
    makeAssistantMessage("recent exact tail one") as Message,
    makeUserMessage("recent exact tail two") as Message,
  ]
  const preSummaryWake = makeUserMessage("legacy wake message before summary") as Message

  const snapshot = contextStore.recordRestContextSnapshot([
    preSummaryWake,
    { role: "user", content: parentForest },
    ...tail,
  ] as Message[], "going to sleep")

  assert.notEqual(snapshot.summaryId, parentId)
  assert.equal(contextSummaryId(snapshot.forest), snapshot.summaryId)
  assert.doesNotMatch(snapshot.forest, new RegExp(parentId))
  const expanded = contextStore.expandContextSummary(snapshot.summaryId, 0, 10)
  assert.ok(expanded)
  assert.deepEqual(
    expanded.messages.map(sourceContent),
    [oldSource.content, preSummaryWake.content, tail[0]?.content, tail[1]?.content],
  )
})

test("rest snapshot creates a recoverable summary before the first compaction", () => {
  const raw = { role: "user", content: `never compacted ${Date.now()}` } as Message
  const snapshot = contextStore.recordRestContextSnapshot([
    { role: "system", content: "bootstrap" },
    raw,
  ] as Message[])

  assert.match(snapshot.forest, /^\[context summary v1\]/)
  assert.equal(contextSummaryId(snapshot.forest), snapshot.summaryId)
  const expanded = contextStore.expandContextSummary(snapshot.summaryId)
  assert.ok(expanded)
  assert.equal(expanded.totalMessages, 2)
  assert.deepEqual(
    expanded.messages.map(sourceContent),
    ["bootstrap", raw.content],
  )
})

test("frontend context archive cannot search or expand main context", () => {
  const marker = `lane-private-${Date.now()}`
  contextStore.archiveContextMessages([{ role: "user", content: `${marker} main` } as Message], "checkpoint", "main")
  contextStore.archiveContextMessages([{ role: "user", content: `${marker} frontend` } as Message], "checkpoint", "frontend")

  assert.deepEqual(contextStore.grepContext(marker, 10, undefined, "main").map((row) => row.content), [`${marker} main`])
  assert.deepEqual(contextStore.grepContext(marker, 10, undefined, "frontend").map((row) => row.content), [`${marker} frontend`])

  const mainSummary = contextStore.recordContextCompaction({
    summaryText: "main only",
    compactedMessages: [{ role: "user", content: `${marker} hidden` } as Message],
    method: "test-main-lane",
    runtimeKind: "main",
  })
  assert.equal(contextStore.describeContextSummary(mainSummary, undefined, "frontend"), null)
  assert.equal(contextStore.expandContextSummary(mainSummary, undefined, undefined, "frontend"), null)
})
