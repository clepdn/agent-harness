import assert from "node:assert/strict"
import test from "node:test"
import { initDb } from "../db"
import {
  configureAgentChannelDelivery,
  listAgentChannelMessages,
  sendAgentChannelMessage,
} from "./agent-channel"

test("agent channel persists bidirectional messages and wakes the recipient", (t) => {
  initDb(":memory:")
  const delivered: Array<{ recipient: string; content: string }> = []
  configureAgentChannelDelivery((recipient, event) => {
    delivered.push({ recipient, content: event.content })
    return true
  })
  t.after(() => configureAgentChannelDelivery(null))

  const first = sendAgentChannelMessage("frontend", "can you help with this?")
  assert.equal(first.recipient, "main")
  assert.equal(first.delivered, true)
  assert.equal(delivered[0]?.recipient, "main")
  assert.match(delivered[0]?.content ?? "", /from frontend/)
  assert.doesNotMatch(delivered[0]?.content ?? "", /message_id:/)

  const second = sendAgentChannelMessage("main", "yes — here is the answer")
  assert.equal(second.recipient, "frontend")
  assert.equal(delivered[1]?.recipient, "frontend")
  assert.doesNotMatch(delivered[1]?.content ?? "", /message_id:/)
  assert.doesNotMatch(delivered[1]?.content ?? "", /reply_to:/)

  const history = listAgentChannelMessages({ limit: 10 }) as { messages: Array<Record<string, unknown>> }
  assert.equal(history.messages.length, 2)
  assert.equal("reply_to" in history.messages[0]!, false)
  assert.equal(history.messages.every((message) => message.delivered === true), true)
})

test("undelivered agent mail replays when delivery is configured", () => {
  initDb(":memory:")
  configureAgentChannelDelivery(null)
  const queued = sendAgentChannelMessage("frontend", "durable pending message")
  assert.equal(queued.delivered, false)

  const received: string[] = []
  configureAgentChannelDelivery((_recipient, event) => {
    received.push(event.content)
    return true
  })
  assert.equal(received.length, 1)
  assert.match(received[0]!, /durable pending message/)
  configureAgentChannelDelivery(null)
})
