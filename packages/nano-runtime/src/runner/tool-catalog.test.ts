import assert from "node:assert/strict"
import test from "node:test"
import { createNiriToolCatalog } from "./tool-catalog"
import { buildToolHandlers } from "./loop-tool-registry"

test("Niri catalog keeps server tools separate from client capabilities", () => {
  const names = createNiriToolCatalog({ discord: false }).map((tool) => tool.function.name)
  assert.equal(names.includes("shell"), false)
  assert.equal(names.includes("memory_search"), true)
  assert.equal(names.includes("discord_send"), false)
})

test("memory catalog exposes durable read and write tools", () => {
  const names = createNiriToolCatalog({ memory: true }).map((tool) => tool.function.name)
  assert.equal(names.includes("memory_write"), true)
  assert.equal(names.includes("memory_read"), true)
})

test("disabled optional services stay out of the catalog", () => {
  const names = createNiriToolCatalog({ discord: false, subagents: false, computer: false })
    .map((tool) => tool.function.name)
  assert.equal(names.includes("discord_send"), false)
  assert.equal(names.includes("discord_search"), false)
  assert.equal(names.includes("subagent"), false)
  assert.equal(names.includes("computer"), false)
})

test("every advertised server tool has a runner handler", () => {
  const handlers = buildToolHandlers()
  const names = createNiriToolCatalog({
    memory: true,
    discord: true,
    webSearch: true,
    subagents: true,
    computer: true,
  }).map((tool) => tool.function.name)

  assert.deepEqual(names.filter((name) => !(name in handlers)), [])
})

test("Discord and client tools are independently gated", () => {
  const names = createNiriToolCatalog({
    clientCapabilities: ["read_file"],
    workspace: { id: "client", root: "/client" },
    discord: true,
  }).map((tool) => tool.function.name)
  assert.equal(names.includes("read_file"), true)
  assert.equal(names.includes("shell"), false)
  assert.equal(names.includes("discord_send"), true)
})

test("web_search is gated on the webSearch option", () => {
  const off = createNiriToolCatalog({}).map((tool) => tool.function.name)
  assert.equal(off.includes("web_search"), false)

  const on = createNiriToolCatalog({ webSearch: true }).map((tool) => tool.function.name)
  assert.equal(on.includes("web_search"), true)
})
