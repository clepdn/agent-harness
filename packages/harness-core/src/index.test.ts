import assert from "node:assert/strict"
import test from "node:test"
import { createClientToolCatalog } from "./index.js"

test("client catalog is empty without attached capabilities", () => {
  assert.deepEqual(createClientToolCatalog(), [])
})

test("client catalog exposes only the attached capabilities", () => {
  const tools = createClientToolCatalog({
    clientCapabilities: ["shell", "image_tool"],
    workspace: { id: "macbook", root: "/Users/mira/project", imageRoot: "/Users/mira/project/images" },
  })
  const byName = new Map(tools.map((tool) => [tool.function.name, tool]))
  assert.equal(byName.has("shell"), true)
  assert.equal(byName.has("read_file"), false)
  assert.equal(byName.has("edit_file"), false)
  assert.match(byName.get("image_tool")?.function.description ?? "", /\/Users\/mira\/project\/images/)
  const shellProperties = byName.get("shell")?.function.parameters.properties as Record<string, unknown>
  assert.deepEqual(shellProperties.pty, {
    type: "boolean",
    description: "Allocate a fresh PTY for this command. Defaults to false.",
  })
  assert.doesNotMatch(byName.get("shell")?.function.description ?? "", /stateful/i)
})
