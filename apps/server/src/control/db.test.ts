import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { ControlStore } from "./db"

test("control history survives store close and reopen", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nano-control-db-"))
  const databasePath = path.join(directory, "control.db")
  try {
    const first = new ControlStore(databasePath)
    first.initialize()
    first.upsertAgent({ id: "mira", name: "Mira", baseUrl: "http://127.0.0.1:4311" })
    first.recordWorkerEvent({
      agentId: "mira",
      seq: 1,
      id: "event-1",
      type: "conversation.started",
      payload: { conversationId: "c1" },
      createdAt: "2026-10-07T00:00:00.000Z",
    })
    first.close()

    const second = new ControlStore(databasePath)
    second.initialize()
    assert.deepEqual(second.getAgent("mira"), {
      id: "mira",
      name: "Mira",
      baseUrl: "http://127.0.0.1:4311",
      status: "online",
      lastSeenAt: second.getAgent("mira")?.lastSeenAt,
      lastSeq: 1,
    })
    assert.deepEqual(second.listMirroredEvents("mira"), [{
      agentId: "mira",
      seq: 1,
      id: "event-1",
      type: "conversation.started",
      payload: { conversationId: "c1" },
      createdAt: "2026-10-07T00:00:00.000Z",
    }])
    second.close()
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
