import assert from "node:assert/strict"
import test from "node:test"
import { createDatabase } from "@nano/plugin-persistence/db"
import { createAgentChannelService } from "./agent-channel"

test("agent channel persists bidirectional messages and wakes ready recipients", async () => {
  const db = createDatabase(":memory:").db
  const delivered: Array<{ recipient: string; content: string }> = []
  const mailbox = createAgentChannelService(db, (recipient, event) => {
    delivered.push({ recipient, content: event.content })
    return true
  })
  await mailbox.runtimeReady("main")
  await mailbox.runtimeReady("frontend")

  const first = await mailbox.sendAgentChannelMessage("frontend", "can you help with this?")
  assert.equal(first.recipient, "main")
  assert.equal(first.delivered, true)
  assert.equal(delivered[0]?.recipient, "main")
  assert.match(delivered[0]?.content ?? "", /from frontend/)

  const second = await mailbox.sendAgentChannelMessage("main", "yes — here is the answer")
  assert.equal(second.recipient, "frontend")
  assert.equal(delivered[1]?.recipient, "frontend")

  const history = mailbox.listAgentChannelMessages({ limit: 10 }) as { messages: Array<Record<string, unknown>> }
  assert.equal(history.messages.length, 2)
  assert.equal(history.messages.every((message) => message.delivered === true), true)
  db.close()
})

test("undelivered agent mail replays after the recipient becomes ready", async () => {
  const db = createDatabase(":memory:").db
  const received: string[] = []
  let accepting = false
  const mailbox = createAgentChannelService(db, (_recipient, event) => {
    if (!accepting) return false
    received.push(event.content)
    return true
  })
  const queued = await mailbox.sendAgentChannelMessage("frontend", "durable pending message")
  assert.equal(queued.delivered, false)
  accepting = true
  await mailbox.runtimeReady("main")
  assert.equal(received.length, 1)
  assert.match(received[0]!, /durable pending message/)
  db.close()
})
