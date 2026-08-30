import assert from "node:assert/strict"
import test from "node:test"
import { handshakeErrorMessage } from "./args.js"

test("explains how to select a worker after an unscoped 404 handshake", () => {
  const message = handshakeErrorMessage(404, "Not Found", '{"error":"Route POST:/client/connect not found"}', "http://127.0.0.1:4220")
  assert.match(message, /pass --agent/)
  assert.match(message, /selected worker URL/)
  assert.match(message, /Route POST:\/client\/connect not found/)
})

test("identifies a missing agent after a scoped 404 handshake", () => {
  const message = handshakeErrorMessage(404, "Not Found", '{"error":"agent not found"}', "http://127.0.0.1:4220", "mira")
  assert.match(message, /agent mira/)
  assert.match(message, /Verify that --agent names an agent/)
})

test("keeps non-404 handshake failures actionable without mislabeling them", () => {
  const message = handshakeErrorMessage(502, "Bad Gateway", "worker unavailable", "http://127.0.0.1:4221")
  assert.equal(message, "handshake failed (502 Bad Gateway): worker unavailable")
})
