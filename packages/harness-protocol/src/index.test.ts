import assert from "node:assert/strict"
import test from "node:test"
import {
  parseClientToolResult,
  parseToolInvocation,
} from "./index.js"

test("wire parsers reject unknown tools, array args, and malformed dates", () => {
  assert.equal(
    parseToolInvocation({
      type: "tool.call",
      invocationId: "i",
      agentId: "a",
      tool: "server_shell",
      args: {},
      issuedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 1_000).toISOString(),
    }),
    null,
  )
  assert.equal(
    parseToolInvocation({
      type: "tool.call",
      invocationId: "i",
      agentId: "a",
      tool: "shell",
      args: [],
      issuedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 1_000).toISOString(),
    }),
    null,
  )
})

test("tool result image metadata must match a bounded image data URL shape", () => {
  const base = {
    type: "tool.result",
    invocationId: "i",
    agentId: "a",
    status: "ok",
    completedAt: new Date().toISOString(),
  }
  assert.equal(
    parseClientToolResult({
      ...base,
      image: { path: "x", mime: "text/plain", bytes: -1, dataUrl: "data:text/plain;base64,eA==" },
    }),
    null,
  )
  assert.equal(
    parseClientToolResult({
      ...base,
      image: { path: "x.png", mime: "image/png", bytes: 1, dataUrl: "data:image/png;base64,eA==" },
    })?.image?.mime,
    "image/png",
  )
})

test("file artifacts carry any mime but keep the image artifact's bounds", () => {
  const base = {
    type: "tool.result",
    invocationId: "i",
    agentId: "a",
    status: "ok",
    completedAt: new Date().toISOString(),
  }
  assert.equal(
    parseClientToolResult({
      ...base,
      file: { path: "notes.txt", mime: "text/plain", bytes: 1, dataUrl: "data:text/plain;base64,eA==" },
    })?.file?.mime,
    "text/plain",
  )
  // dataUrl must agree with the declared mime
  assert.equal(
    parseClientToolResult({
      ...base,
      file: { path: "notes.txt", mime: "text/plain", bytes: 1, dataUrl: "data:application/zip;base64,eA==" },
    }),
    null,
  )
  // artifacts only ride along with a successful call
  assert.equal(
    parseClientToolResult({
      ...base,
      status: "error",
      file: { path: "notes.txt", mime: "text/plain", bytes: 1, dataUrl: "data:text/plain;base64,eA==" },
    }),
    null,
  )
})
