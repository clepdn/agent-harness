import assert from "node:assert/strict"
import test from "node:test"
import { realtimeCallBody, realtimeCallRequest, realtimeCallsUrl } from "./voice"

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
