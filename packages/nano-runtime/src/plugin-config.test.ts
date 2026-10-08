import assert from "node:assert/strict"
import test from "node:test"
import { validatePluginSelections } from "./config"

test("plugin selections preserve config and permit independent disabling", () => {
  const input = { memory: { enabled: false }, provider: { config: { model: "local" } } }
  const selections = validatePluginSelections(input)
  assert.equal(selections.memory.enabled, false)
  assert.equal(selections.provider.enabled, true)
  assert.deepEqual(selections.provider.config, { model: "local" })
  assert.deepEqual(input, { memory: { enabled: false }, provider: { config: { model: "local" } } })
})

test("plugin selections reject malformed settings without disclosing values", () => {
  for (const input of [null, [], "private-setting", { memory: false }, { memory: { enabled: "private-setting" } }, { memory: { typo: "private-setting" } }]) {
    assert.throws(() => validatePluginSelections(input), (error: unknown) =>
      error instanceof TypeError && !error.message.includes("private-setting"))
  }
  assert.throws(() => validatePluginSelections({ "bad id": {} }), /invalid plugin id/)
})
