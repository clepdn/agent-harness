import assert from "node:assert/strict"
import test from "node:test"
import { createNiriToolCatalog, reconcileImageToolDefinition, reconcileMemoryFileToolDefinitions } from "./tool-catalog"
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
  assert.deepEqual(edit.function.parameters.required, ["path", "old_text", "new_text"])
  assert.ok((edit.function.parameters.properties as Record<string, unknown>).old_text)
  assert.equal((edit.function.parameters.properties as Record<string, unknown>).edits, undefined)
  const hashlineEdit = createNiriToolCatalog({ memory: true, workspace: { id: "client", root: "/client", hashline: true } })
    .find((tool) => tool.function.name === "edit_file")!
  assert.deepEqual(hashlineEdit.function.parameters.required, ["path", "edits"])
  assert.ok((hashlineEdit.function.parameters.properties as Record<string, unknown>).edits)
  assert.equal((hashlineEdit.function.parameters.properties as Record<string, unknown>).old_text, undefined)
  const read = tools.find((tool) => tool.function.name === "read_file")!
  assert.deepEqual(read.function.parameters.required, ["path"])
  const hashlineRead = createNiriToolCatalog({ memory: true, workspace: { id: "client", root: "/client", hashline: true } })
    .find((tool) => tool.function.name === "read_file")!
  assert.match(hashlineRead.function.description, /Text file lines are prefixed/)
  const memoryFs = tools.find((tool) => tool.function.name === "memory_fs")!
  assert.deepEqual(memoryFs.function.parameters.required, ["file_name", "op"])
  assert.deepEqual(Object.keys(memoryFs.function.parameters.properties ?? {}).sort(), ["file_name", "op", "target"])
  const memoryFsProperties = memoryFs.function.parameters.properties as Record<string, { enum?: string[] }>
  assert.deepEqual(memoryFsProperties.op.enum, ["ls", "create", "delete", "move", "copy"])
  assert.match(memoryFs.function.description, /ls[\s\S]*list/i)
  assert.match(memoryFs.function.description, /memory:\/\/[\s\S]*relative directory/i)
  assert.match(memoryFs.function.description, /immediate[\s\S]*sort/i)
  assert.match(memoryFs.function.description, /directories.*\//i)
  assert.match(memoryFs.function.description, /ls.*not.*target.*local:\/\//i)

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

test("restored catalogs adopt current memory file contracts", () => {
  const current = createNiriToolCatalog({ memory: true })
  const saved = current.map((tool) => tool.function.name === "read_file"
    ? { ...tool, function: { ...tool.function, description: "Read a memory file." } }
    : tool.function.name === "memory_fs"
    ? { ...tool, function: { ...tool.function, description: "Copy a runtime container file into memory." } }
    : tool.function.name === "edit_file" ? {
        ...tool,
        function: {
          ...tool.function,
          parameters: {
            ...tool.function.parameters,
            properties: {
              ...(tool.function.parameters.properties as Record<string, unknown>),
              old_text: { type: "string", minLength: 1 },
            },
          },
        },
      }
    : tool)
  const reconciled = reconcileMemoryFileToolDefinitions(saved, current)
  assert.equal(reconciled.changed, true)
  assert.deepEqual(reconciled.catalog, current)
  assert.equal(reconcileMemoryFileToolDefinitions(reconciled.catalog, current).changed, false)
})

test("edit schemas select one format for main, frontend, and unattached runtimes", () => {
  for (const frontend of [false, true]) {
    for (const hashline of [false, true]) {
      const tools = createNiriToolCatalog({ frontend, workspace: { id: "test", root: "/test", hashline } })
      const edit = tools.find((tool) => tool.function.name === "edit_file")!
      const fields = edit.function.parameters.properties as Record<string, { minLength?: number }>
      assert.equal("edits" in fields, hashline)
      assert.equal("old_text" in fields, !hashline)
      assert.equal("new_text" in fields, !hashline)
      assert.equal(fields.old_text?.minLength, undefined, "empty memory files remain initializable")
      const read = tools.find((tool) => tool.function.name === "read_file")!
      assert.equal(read.function.description.includes("LINE#HASH"), hashline)
    }
    const unattached = createNiriToolCatalog({ frontend, workspace: null }).find((tool) => tool.function.name === "edit_file")!
    assert.deepEqual(unattached.function.parameters.required, ["path", "old_text", "new_text"])
  }
})

test("restored mixed edit schemas adopt the current mode without replacing unrelated tools", () => {
  for (const hashline of [true, false]) {
    const current = createNiriToolCatalog({ workspace: { id: "test", root: "/test", hashline } })
    const saved = current.map((tool) => tool.function.name === "edit_file" ? {
      ...tool,
      function: { ...tool.function, parameters: { type: "object", properties: { path: {}, old_text: {}, new_text: {}, edits: {} }, required: ["path"] } },
    } : tool)
    const restored = reconcileMemoryFileToolDefinitions(saved, current)
    assert.equal(restored.changed, true)
    assert.deepEqual(restored.catalog, current)
    for (const tool of saved.filter((tool) => !["read_file", "edit_file"].includes(tool.function.name))) {
      assert.equal(restored.catalog.find((item) => item.function.name === tool.function.name), tool)
    }
    assert.equal(reconcileMemoryFileToolDefinitions(restored.catalog, current).changed, false)
  }
})
