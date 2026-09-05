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

test("memory catalog exposes unified edit and read tools", () => {
  const tools = createNiriToolCatalog({ memory: true })
  const names = tools.map((tool) => tool.function.name)
  assert.equal(names.includes("edit_file"), true)
  assert.equal(names.filter((name) => name === "edit_file").length, 1)
  assert.equal(names.includes("memory_write"), false)
  assert.equal(names.includes("soul_write"), false)
  assert.equal(names.includes("memory_read"), true)
  const edit = tools.find((tool) => tool.function.name === "edit_file")!
  assert.deepEqual(edit.function.parameters.required, ["path"])
  assert.ok((edit.function.parameters.properties as Record<string, unknown>).old_text)
  assert.ok((edit.function.parameters.properties as Record<string, unknown>).edits)
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

test("shell catalog exposes explicit per-command PTY allocation", () => {
  const shell = createNiriToolCatalog({
    clientCapabilities: ["shell"],
    workspace: { id: "client", root: "/client", persistentShell: false },
  }).find((tool) => tool.function.name === "shell")
  const properties = shell?.function.parameters.properties as Record<string, unknown>
  assert.deepEqual(properties.pty, {
    type: "boolean",
    description: "Allocate a fresh PTY for this command. Defaults to false.",
  })
  assert.match(shell?.function.description ?? "", /fresh process/)
})

test("web_search is gated on the webSearch option", () => {
  const off = createNiriToolCatalog({}).map((tool) => tool.function.name)
  assert.equal(off.includes("web_search"), false)

  const on = createNiriToolCatalog({ webSearch: true }).map((tool) => tool.function.name)
  assert.equal(on.includes("web_search"), true)
})
