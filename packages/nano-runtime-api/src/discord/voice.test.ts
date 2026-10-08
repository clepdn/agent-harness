import assert from "node:assert/strict"
import test from "node:test"
import { delegationReplyMessages, isVoiceChannelEmpty, parseDelegationCreated, realtimeCallBody, realtimeCallRequest, realtimeCallsUrl, utf8Chunks } from "./voice"

test("Frameless delegation parsing and reply messages match the Codex wire contract", () => {
  assert.deepEqual(parseDelegationCreated({
    type: "delegation.created",
    item: {
      id: "d1",
      type: "delegation",
      target: "client",
      content: [
        { type: "input_text", text: "hello " },
        { type: "ignored", text: "private" },
        { type: "input_text", text: "world" },
      ],
    },
  }), { id: "d1", transcript: "hello world" })
  assert.equal(parseDelegationCreated({ type: "delegation.created", item: { id: "d1", type: "delegation", target: "server", content: [] } }), null)
  assert.deepEqual(utf8Chunks("🙂🙂", 5), ["🙂", "🙂"])
  assert.deepEqual(delegationReplyMessages("d1", "answer"), [JSON.stringify({
    type: "delegation.context.append",
    delegation_item_id: "d1",
    channel: "speakable",
    content: [{ type: "input_text", text: "answer" }],
  })])
})

test("voice channel is empty only when every member is a bot", () => {
  assert.equal(isVoiceChannelEmpty({ members: new Map([["bot", { user: { bot: true } }]]) }), true)
  assert.equal(isVoiceChannelEmpty({ members: new Map([["human", { user: { bot: false } }]]) }), false)
})

test("realtimeCallsUrl accepts bridge roots with or without /v1", () => {
  assert.equal(realtimeCallsUrl("http://bridge:4041"), "http://bridge:4041/v1/realtime/calls")
  assert.equal(realtimeCallsUrl("http://bridge:4041/"), "http://bridge:4041/v1/realtime/calls")
  assert.equal(realtimeCallsUrl("http://bridge:4041/v1"), "http://bridge:4041/v1/realtime/calls")
  assert.throws(() => realtimeCallsUrl("  "), /not configured/)
})


test("realtimeCallRequest uses the bridge JSON adapter with the Frameless V3 session", () => {
  const request = realtimeCallRequest(
    "https://bridge.example/v1",
    "secret",
    "v=offer\r\n",
    "gpt-live-1-codex",
    "Be concise.",
    "cove",
  )

  assert.equal(request.url, "https://bridge.example/v1/realtime/calls")
  assert.deepEqual(request.init.headers, {
    authorization: "Bearer secret",
    "content-type": "application/json",
    accept: "application/sdp",
  })
  assert.deepEqual(JSON.parse(String(request.init.body)), realtimeCallBody(
    "v=offer\r\n",
    "gpt-live-1-codex",
    "Be concise.",
    "cove",
  ))
  assert.deepEqual(JSON.parse(String(request.init.body)), {
    sdp: "v=offer\r\n",
    session: {
      model: "gpt-live-1-codex",
      instructions: "Be concise.",
      audio: { output: { voice: "cove" } },
      delegation: { type: "client" },
    },
  })
})
