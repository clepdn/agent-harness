import assert from "node:assert/strict"
import test from "node:test"
import { createRuntimeContext } from "./context"

test("runtime context restoration preserves matching lineage and forks changed configuration", () => {
  const original = createRuntimeContext("main", [], [])
  const restored = createRuntimeContext("main", [], [], {
    id: "saved-context",
    parentId: "saved-parent",
    forkReason: "compaction",
    configurationFingerprint: original.configurationFingerprint,
    modelId: original.model.id,
  })

  assert.equal(restored.id, "saved-context")
  assert.equal(restored.parentId, "saved-parent")
  assert.equal(restored.forkReason, "compaction")

  const changed = createRuntimeContext("main", [], [], {
    id: "old-context",
    configurationFingerprint: "different-configuration",
    modelId: "different-model",
  })
  assert.notEqual(changed.id, "old-context")
  assert.equal(changed.parentId, "old-context")
  assert.equal(changed.forkReason, "model-change")
})
