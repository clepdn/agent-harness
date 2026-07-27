import assert from "node:assert/strict"
import test from "node:test"
import { deepMerge, isTable, parseToml } from "./index.js"

test("parses tables, nesting, and scalar types", () => {
  const table = parseToml(`
port = 3000
enabled = true
ratio = 0.5

[model]
name = "gpt-5"

[model.limits]
max = 10
`)
  assert.deepEqual(table, {
    port: 3000,
    enabled: true,
    ratio: 0.5,
    model: { name: "gpt-5", limits: { max: 10 } },
  })
})

test("parses arrays of scalars and arrays of tables", () => {
  const table = parseToml(`
ids = ["123", "456"]
empty = []

[[subagents]]
name = "explore"

[[subagents]]
name = "coder"
`)
  assert.deepEqual(table.ids, ["123", "456"])
  assert.deepEqual(table.empty, [])
  assert.deepEqual(table.subagents, [{ name: "explore" }, { name: "coder" }])
})

test("comments outside strings are stripped, inside strings are kept", () => {
  const table = parseToml(`
# leading comment
key = "value" # trailing comment
hashy = "a # b"
literal = 'c # d'
`)
  assert.equal(table.key, "value")
  assert.equal(table.hashy, "a # b")
  assert.equal(table.literal, "c # d")
})

test("malformed input throws", () => {
  assert.throws(() => parseToml("key =\n"), /missing TOML value/)
  assert.throws(() => parseToml("no equals sign\n"), /invalid TOML line/)
  assert.throws(() => parseToml("[]\n"), /empty table header/)
  assert.throws(() => parseToml("a = 1\n[a.b]\nc = 2\n"), /overlaps a non-table value/)
})

test("deepMerge overlays nested tables without dropping siblings", () => {
  const merged = deepMerge(
    { model: { name: "base", base_url: "http://base" }, port: 1 },
    { model: { name: "overlay" } },
  )
  assert.deepEqual(merged, { model: { name: "overlay", base_url: "http://base" }, port: 1 })
})

test("isTable rejects arrays and null", () => {
  assert.equal(isTable({}), true)
  assert.equal(isTable([]), false)
  assert.equal(isTable(null), false)
})
