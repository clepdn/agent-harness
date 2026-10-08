import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import type { ToolDefinition } from "@nano/harness-core"
import type { ToolCapability, WorkspaceDescriptor } from "@nano/harness-protocol"
import { createNiriToolCatalog, reconcileImageToolDefinition, reconcileMemoryFileToolDefinitions } from "./tool-catalog"
import { createExecutionServices, type TestExecutionFixture } from "../../../../tests/support/runtime-services"
import { nano, registerTool, type ToolContribution } from "@nano/runtime-api"
import { Contributions, CordisContext, getService, listContributions } from "@nano/plugins"
import { memoryPlugin } from "@nano/plugin-memory"
import { clientPlugin } from "@nano/plugin-client"
import { toolFamiliesPlugin } from "@nano/plugin-tool-families"
import { createPersistencePlugin } from "@nano/plugin-persistence"

function catalog(fixture: TestExecutionFixture, options: { frontend?: boolean; vision?: boolean; computer?: boolean; clientCapabilities?: ToolCapability[]; workspace?: WorkspaceDescriptor | null } = {}) {
  return createNiriToolCatalog({
    contributions: listContributions(fixture.ctx, nano.toolContributions).map((entry) => entry.value),
    frontend: options.frontend,
    vision: options.vision,
    computer: options.computer,
    clientCapabilities: options.clientCapabilities ?? fixture.services.client.capabilities(),
    workspace: options.workspace === undefined ? fixture.services.client.workspace() : options.workspace,
  })
}

function names(tools: readonly ToolDefinition[]): string[] {
  return tools.map((tool) => tool.function.name)
}

const pinnedFingerprint = (tools: readonly ToolDefinition[]): string => createHash("sha256").update(JSON.stringify(tools)).digest("hex")


test("catalog availability follows installed services and client capabilities", async (t) => {
  const fixture = await createExecutionServices()
  t.after(() => fixture.close())
  const toolNames = names(catalog(fixture))
  assert.equal(toolNames.includes("read_file"), true)
  assert.equal(toolNames.includes("edit_file"), true)
  assert.equal(toolNames.includes("memory_search"), true)
  assert.equal(toolNames.includes("job_list"), false)
  assert.equal(toolNames.includes("discord_send"), false)
  const disconnected = names(catalog(fixture, { clientCapabilities: [], workspace: null }))
  assert.equal(disconnected.includes("read_file"), true)
  assert.equal(disconnected.includes("edit_file"), true)
  assert.equal(disconnected.includes("memory_search"), true)
  assert.equal(disconnected.includes("shell"), false)
})

test("catalog definitions retain arbitrary third-party keys and resolve mode-specific metadata", async (t) => {
  const fixture = await createExecutionServices()
  t.after(() => fixture.close())
  const contribution: ToolContribution = {
    definition: { type: "function", function: { name: "example_arbitrary_key", description: "base", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
    definitionFor: (context): ToolDefinition => ({
      ...contribution.definition,
      function: {
        ...contribution.definition.function,
        parameters: context.workspace?.hashline
          ? { type: "object", properties: { path: { type: "string" }, edits: { type: "array" } }, required: ["path", "edits"] }
          : { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] },
      },
    }),
    execute: () => "ok",
  }
  const fiber = await fixture.ctx.plugin({ name: "test.arbitrary-tool", inject: ["nano.contributions"], apply(ctx) { return registerTool(ctx, "example_arbitrary_key", contribution) } })
  try {
    const contributions = [...fixture.services.tools.list("main"), ...listContributions(fixture.ctx, nano.toolContributions).map((entry) => entry.value)]
    const exact = createNiriToolCatalog({ contributions, workspace: { id: "test", root: fixture.home, hashline: false } })
    const hashline = createNiriToolCatalog({ contributions, workspace: { id: "test", root: fixture.home, hashline: true } })
    const exactProperties = exact.find((tool) => tool.function.name === "example_arbitrary_key")?.function.parameters.properties as Record<string, unknown> | undefined
    const hashlineProperties = hashline.find((tool) => tool.function.name === "example_arbitrary_key")?.function.parameters.properties as Record<string, unknown> | undefined
    assert.ok(exactProperties && "old_text" in exactProperties && "new_text" in exactProperties)
    assert.ok(hashlineProperties && "edits" in hashlineProperties)
  } finally {
    await fiber.dispose()
  }

})
test("Discord tools require a real available Discord service", async (t) => {
  const fixture = await createExecutionServices({ discord: true })
  t.after(() => fixture.close())
  assert.ok(fixture.services.discord)
  assert.equal(fixture.services.discord.available, false)
  const toolNames = names(catalog(fixture))
  assert.equal(toolNames.includes("discord_send"), false)
  assert.equal(toolNames.includes("discord_search"), false)
})

test("frontend catalog keeps server tools while omitting main-runtime capabilities", async (t) => {
  const fixture = await createExecutionServices()
  t.after(() => fixture.close())
  const toolNames = names(catalog(fixture, { frontend: true, vision: true, computer: true }))
  for (const denied of ["shell", "computer", "job_list", "subagent", "skill"]) assert.equal(toolNames.includes(denied), false)
  for (const allowed of ["read_file", "edit_file", "memory_fs", "memory_search", "wait", "end_session"]) assert.equal(toolNames.includes(allowed), true)
})

test("vision catalog reconciliation changes only image_tool in a pinned catalog", async (t) => {
  const fixture = await createExecutionServices()
  t.after(() => fixture.close())
  const saved = catalog(fixture, { vision: false })
  const current = catalog(fixture, { vision: true, frontend: true })
  const reconciled = reconcileImageToolDefinition(saved, current)
  assert.equal(reconciled.changed, true)
  assert.ok(reconciled.catalog.find((tool) => tool.function.name === "image_tool"))
  assert.deepEqual(reconciled.catalog.filter((tool) => tool.function.name !== "image_tool"), saved)
  assert.equal(reconcileImageToolDefinition(reconciled.catalog, current).changed, false)
})

test("memory catalog retains the pinned edit contract and unrelated tools", async (t) => {
  const fixture = await createExecutionServices()
  t.after(() => fixture.close())
  const current = catalog(fixture)
  const toolNames = names(current)
  assert.equal(toolNames.filter((name) => name === "read_file").length, 1)
  assert.equal(toolNames.filter((name) => name === "edit_file").length, 1)
  assert.equal(toolNames.includes("memory_fs"), true)
  const saved = current.map((tool) => tool.function.name === "edit_file" ? {
    ...tool,
    function: { ...tool.function, parameters: { type: "object", properties: { path: {}, edits: {}, old_text: {}, new_text: {} }, required: ["path"] } },
  } : tool)
  const reconciled = reconcileMemoryFileToolDefinitions(saved, current)
  assert.equal(reconciled.changed, true)
  assert.deepEqual(reconciled.catalog, current)
  for (const tool of saved.filter((entry) => !["read_file", "edit_file", "memory_fs"].includes(entry.function.name))) {
    assert.strictEqual(reconciled.catalog.find((entry) => entry.function.name === tool.function.name), tool)
  }
  assert.equal(reconcileMemoryFileToolDefinitions(reconciled.catalog, current).changed, false)
})

test("saved catalog fingerprint changes only when pinned file mode is reconciled", async (t) => {
  const fixture = await createExecutionServices({ hashline: false })
  t.after(() => fixture.close())
  const workspace = fixture.services.client.workspace()
  assert.ok(workspace)
  const current = catalog(fixture, { workspace: { ...workspace, hashline: true } })
  const saved = catalog(fixture)
  const fingerprint = pinnedFingerprint(saved)
  const restored = reconcileMemoryFileToolDefinitions(saved, current)
  assert.equal(restored.changed, true)
  assert.notEqual(pinnedFingerprint(restored.catalog), fingerprint)
  assert.deepEqual(restored.catalog, current)
})

test("late memory expands the live catalog without losing client file tools", async (t) => {
  const fixture = await createExecutionServices()
  t.after(() => fixture.close())
  await fixture.fibers.get("nano.tool-families")!.dispose()
  await fixture.fibers.get("nano.memory")!.dispose()
  const families = await fixture.ctx.plugin(toolFamiliesPlugin)
  const before = names(catalog(fixture))
  assert.equal(before.includes("read_file"), true)
  assert.equal(before.includes("edit_file"), true)
  assert.equal(before.includes("memory_search"), false)
  await fixture.ctx.plugin(memoryPlugin)
  await families.await()
  const after = names(catalog(fixture))
  assert.equal(after.includes("memory_search"), true)
  assert.equal(after.filter((name) => name === "read_file").length, 1)
  assert.equal(after.filter((name) => name === "edit_file").length, 1)
})

test("late client extends image tools instead of colliding with remote-only images", async (t) => {
  const fixture = await createExecutionServices()
  t.after(() => fixture.close())
  await fixture.fibers.get("nano.tool-families")!.dispose()
  await fixture.fibers.get("nano.client")!.dispose()
  const families = await fixture.ctx.plugin(toolFamiliesPlugin)
  const remoteOnly = catalog(fixture, { vision: true, clientCapabilities: [], workspace: null })
  assert.equal(names(remoteOnly).filter((name) => name === "image_tool").length, 1)
  const remoteProperties = remoteOnly.find((tool) => tool.function.name === "image_tool")!.function.parameters.properties as Record<string, unknown>
  assert.equal(remoteProperties.detail, undefined)
  await fixture.ctx.plugin(clientPlugin({ agentId: "late-catalog-client", workspaceRoot: fixture.home }))
  await families.await()
  const client = getService(fixture.ctx, nano.client)
  const attached = catalog(fixture, { vision: true, clientCapabilities: client.capabilities(), workspace: client.workspace() })
  assert.equal(names(attached).filter((name) => name === "image_tool").length, 1)
  const attachedProperties = attached.find((tool) => tool.function.name === "image_tool")!.function.parameters.properties as Record<string, unknown>
  assert.deepEqual(attachedProperties.detail, { type: "string", enum: ["auto", "low", "high"] })
})

test("late storage enables end_session in the live model catalog", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nano-late-storage-"))
  await mkdir(path.join(home, "memories"))
  const ctx = new CordisContext()
  t.after(async () => {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  await ctx.plugin(Contributions)
  await ctx.plugin(toolFamiliesPlugin)
  const liveCatalog = () => createNiriToolCatalog({ contributions: listContributions(ctx, nano.toolContributions).map((entry) => entry.value) })
  assert.equal(names(liveCatalog()).includes("end_session"), false)
  const storage = await ctx.plugin(createPersistencePlugin({ home, path: ":memory:" }), {})
  assert.equal(names(liveCatalog()).includes("end_session"), true)
  await storage.dispose()
  assert.equal(names(liveCatalog()).includes("end_session"), false)
})
