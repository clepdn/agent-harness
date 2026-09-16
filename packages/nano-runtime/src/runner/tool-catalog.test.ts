import assert from "node:assert/strict"
import test from "node:test"
import { createNiriToolCatalog, reconcileImageToolDefinition } from "./tool-catalog"
import { buildToolHandlers } from "./loop-tool-registry"

test("Niri catalog keeps server tools separate from client capabilities", () => {
  const names = createNiriToolCatalog({ discord: false }).map((tool) => tool.function.name)
  assert.equal(names.includes("shell"), false)
  assert.equal(names.includes("memory_search"), true)
  assert.equal(names.includes("discord_send"), false)
  assert.equal(names.includes("job_list"), true)
  assert.equal(names.includes("job_status"), true)
  assert.equal(names.includes("job_stdout"), true)
  assert.equal(names.includes("job_cancel"), true)
})

test("memory catalog exposes unified file tools", () => {
  const tools = createNiriToolCatalog({ memory: true })
  const names = tools.map((tool) => tool.function.name)
  assert.equal(names.includes("edit_file"), true)
  assert.equal(names.filter((name) => name === "edit_file").length, 1)
  assert.equal(names.includes("memory_write"), false)
  assert.equal(names.includes("soul_write"), false)
  assert.equal(names.includes("read_file"), true)
  assert.equal(names.filter((name) => name === "read_file").length, 1)
  assert.equal(names.includes("memory_fs"), true)
  assert.equal(names.filter((name) => name === "memory_fs").length, 1)
  assert.equal(names.includes("memory_read"), false)
  assert.equal(names.includes("memory_ls"), false)
  const edit = tools.find((tool) => tool.function.name === "edit_file")!
  assert.deepEqual(edit.function.parameters.required, ["path"])
  assert.ok((edit.function.parameters.properties as Record<string, unknown>).old_text)
  assert.ok((edit.function.parameters.properties as Record<string, unknown>).edits)
  const read = tools.find((tool) => tool.function.name === "read_file")!
  assert.deepEqual(read.function.parameters.required, ["path"])
  const memoryFs = tools.find((tool) => tool.function.name === "memory_fs")!
  assert.deepEqual(memoryFs.function.parameters.required, ["file_name", "op"])
  assert.deepEqual(Object.keys(memoryFs.function.parameters.properties ?? {}).sort(), ["file_name", "op", "target"])
})

test("memory catalog exposes guarded Discord vector pruning", () => {
  const tools = createNiriToolCatalog({ memory: true })
  const prune = tools.find((tool) => tool.function.name === "memory_prune")!
  assert.ok(prune)
  assert.match(prune.function.description, /ONLY/)
  assert.deepEqual(prune.function.parameters.required, ["id", "reason"])
  const properties = prune.function.parameters.properties as Record<string, { enum?: string[]; pattern?: string }>
  assert.equal(properties.id?.pattern, "^discord:[0-9]+$")
  assert.deepEqual(properties.reason?.enum, ["explicit_request", "surfaced_incorrect", "surfaced_stale"])
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
  const tools = createNiriToolCatalog({
    clientCapabilities: ["read_file"],
    workspace: { id: "client", root: "/client" },
    discord: true,
  })
  const names = tools.map((tool) => tool.function.name)
  assert.equal(names.includes("read_file"), true)
  assert.equal(names.includes("shell"), false)
  assert.equal(names.includes("discord_send"), true)
  const sendProperties = tools.find((tool) => tool.function.name === "discord_send")!
    .function.parameters.properties as Record<string, unknown>
  assert.deepEqual(Object.keys(sendProperties).sort(), ["channel_id", "content", "reference_message", "reply_mode", "target"])
  assert.match(String((sendProperties.channel_id as { description?: string }).description), /plant-object-object/)
  assert.match(String((sendProperties.reference_message as { description?: string }).description), /plant-object-object/)
})

test("server memory keeps read_file available without an attached client", () => {
  const names = createNiriToolCatalog({ memory: true }).map((tool) => tool.function.name)
  assert.equal(names.includes("read_file"), true)
})

test("vision runtimes get server-side URL image_tool without a client", () => {
  const tool = createNiriToolCatalog({ vision: true }).find((entry) => entry.function.name === "image_tool")
  assert.ok(tool)
  assert.match(tool.function.description, /public HTTP\(S\) URL/)
  assert.match(String((tool.function.parameters.properties as Record<string, { description?: string }>).path?.description), /HTTP\(S\)/)
})

test("restored catalogs adopt URL image_tool without replacing other pinned tools", () => {
  const saved = createNiriToolCatalog({ vision: false })
  const current = createNiriToolCatalog({ vision: true, frontend: true })
  const reconciled = reconcileImageToolDefinition(saved, current)
  assert.equal(reconciled.changed, true)
  assert.ok(reconciled.catalog.find((tool) => tool.function.name === "image_tool"))
  assert.deepEqual(
    reconciled.catalog.filter((tool) => tool.function.name !== "image_tool"),
    saved,
  )
  assert.equal(reconcileImageToolDefinition(reconciled.catalog, current).changed, false)
})

test("shell catalog exposes explicit per-command PTY allocation", () => {
  const shell = createNiriToolCatalog({
    clientCapabilities: ["shell"],
    workspace: { id: "client", root: "/client", persistentShell: false },
  }).find((tool) => tool.function.name === "shell")
  const properties = shell?.function.parameters.properties as Record<string, unknown>
  assert.equal((properties.pty as { type?: unknown }).type, "boolean")
})

test("web_search is gated on the webSearch option", () => {
  const off = createNiriToolCatalog({}).map((tool) => tool.function.name)
  assert.equal(off.includes("web_search"), false)

  const on = createNiriToolCatalog({ webSearch: true }).map((tool) => tool.function.name)
  assert.equal(on.includes("web_search"), true)
})

test("frontend catalog keeps server tools and bridge while hard-gating executor and skills", () => {
  const tools = createNiriToolCatalog({
    clientCapabilities: ["shell", "read_file", "edit_file", "image_tool"],
    workspace: { id: "client", root: "/client" },
    memory: true,
    discord: true,
    webSearch: true,
    subagents: true,
    computer: true,
    vision: true,
    frontend: true,
    agentChannel: true,
  })
  const names = tools.map((tool) => tool.function.name)
  for (const denied of ["shell", "job_list", "job_status", "job_stdout", "job_cancel", "computer", "subagent", "skill", "discord_upload"]) {
    assert.equal(names.includes(denied), false, `${denied} should be absent`)
  }
  for (const allowed of ["read_file", "edit_file", "memory_fs", "memory_search", "discord_send", "discord_search", "web_search", "image_tool", "agent_send", "agent_channel", "wait", "end_session"]) {
    assert.equal(names.includes(allowed), true, `${allowed} should remain available`)
  }
  assert.match(tools.find((tool) => tool.function.name === "read_file")!.function.description, /Ordinary.*unavailable/)
  assert.match(tools.find((tool) => tool.function.name === "image_tool")!.function.description, /public HTTP\(S\) URL/)
  assert.doesNotMatch(tools.find((tool) => tool.function.name === "image_tool")!.function.description, /client file/)
})
