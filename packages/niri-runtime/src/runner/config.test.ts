import assert from "node:assert/strict"
import test from "node:test"
import { meetsToolResultCompactionContextThreshold } from "./config"

test("tool-result compaction waits for the configured context percentage", () => {
  assert.equal(meetsToolResultCompactionContextThreshold(99_999, 200_000, 50), false)
  assert.equal(meetsToolResultCompactionContextThreshold(100_000, 200_000, 50), true)
  assert.equal(meetsToolResultCompactionContextThreshold(150_000, 200_000, 75), true)
  assert.equal(meetsToolResultCompactionContextThreshold(1, 0, 0), false)
})
