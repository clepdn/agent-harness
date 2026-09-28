import assert from "node:assert/strict"
import test from "node:test"
import { deepMerge, isConfigObject, parseConfig } from "./index.js"

test("JSON preserves nested objects, arrays, nulls, and literal string contents", () => {
  const value = { server: { port: 3000 }, enabled: true, ratio: 0.5, optional: null,
    subagents: [{ name: "explore" }, { name: "coder" }], strings: ["# retained", "line\nnext", "quotes: \""] }
  assert.deepEqual(parseConfig(JSON.stringify(value)), value)
})

test("invalid JSON and unsupported root values fail without quoting secret input", () => {
  for (const source of ["", "[model]\napi_key = \"private-value\"", '{"api_key":"private-value",}']) {
    assert.throws(() => parseConfig(source), error => error instanceof Error && error.message === "Invalid JSON configuration")
  }
  for (const source of ["null", "[]", '"string"', "12", "true"]) {
    assert.throws(() => parseConfig(source), /must be a JSON object/)
  }
  assert.throws(() => parseConfig('{"value":1e400}'), /must be finite/)
})

test("layers merge objects while replacing arrays and nulls without mutating inputs", () => {
  const base = { model: { model: "base", base_url: "http://base" }, tools: ["one"], optional: { key: "old" } }
  const overlay = { model: { model: "overlay" }, tools: ["two"], optional: null }
  assert.deepEqual(deepMerge(base, overlay), {
    model: { model: "overlay", base_url: "http://base" }, tools: ["two"], optional: null,
  })
  assert.deepEqual(base.optional, { key: "old" })
  assert.deepEqual(base.tools, ["one"])
})

test("prototype-named JSON keys stay ordinary own properties", () => {
  const merged = deepMerge({}, parseConfig('{"__proto__":{"polluted":true},"constructor":{"name":"custom"}}'))
  assert.equal(Object.getPrototypeOf(merged), Object.prototype)
  assert.equal(Object.hasOwn(merged, "__proto__"), true)
  assert.deepEqual(merged.__proto__, { polluted: true })
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
})

test("object checks reject arrays, scalars, and null", () => {
  assert.equal(isConfigObject({}), true)
  for (const value of [[], null, "", true, 1]) assert.equal(isConfigObject(value), false)
})
