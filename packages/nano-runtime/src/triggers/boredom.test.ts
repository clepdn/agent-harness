import assert from "node:assert/strict"
import test from "node:test"
import { fromBoredom } from "./boredom"

test("fromBoredom produces a boredom-source activation event", () => {
  const event = fromBoredom()
  assert.equal(event.source, "boredom")
  assert.equal(event.raw, null)
  assert.match(event.content, /boredom/)
  assert.match(event.content, /inbox|feeds|rest/)
  // triggeredAt should be a valid ISO timestamp
  assert.ok(!Number.isNaN(new Date(event.triggeredAt).getTime()))
})
