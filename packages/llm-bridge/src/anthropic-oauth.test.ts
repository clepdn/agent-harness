import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileTokenStore, createAnthropicStore } from "./anthropic-oauth"

function withAuthFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "bridge-auth-"))
  const path = join(dir, "auth.json")
  writeFileSync(path, JSON.stringify(contents, null, 2))
  return path
}

const future = () => Date.now() + 60 * 60 * 1000

test("FileTokenStore reads pi's auth.json format and returns a live access token", async () => {
  const path = withAuthFile({
    anthropic: { type: "oauth", refresh: "r", access: "live-access", expires: future() },
  })
  try {
    const store = new FileTokenStore(path)
    assert.equal(store.hasCredentials(), true)
    assert.equal(await store.getAccessToken(), "live-access")
    // No refresh happened, so the file is untouched.
    const onDisk = JSON.parse(readFileSync(path, "utf-8"))
    assert.equal(onDisk.anthropic.access, "live-access")
  } finally {
    rmSync(path, { force: true })
  }
})

test("FileTokenStore is keyed by provider id and preserves other providers", () => {
  const path = withAuthFile({
    anthropic: { type: "oauth", refresh: "r", access: "a", expires: future() },
    openai: { type: "api_key", key: "sk-openai" },
  })
  try {
    assert.equal(new FileTokenStore(path, "anthropic").hasCredentials(), true)
    assert.equal(new FileTokenStore(path, "missing").hasCredentials(), false)
  } finally {
    rmSync(path, { force: true })
  }
})

test("FileTokenStore throws a clear error when the credential is absent", async () => {
  const path = withAuthFile({ openai: { type: "api_key", key: "sk" } })
  try {
    await assert.rejects(new FileTokenStore(path).getAccessToken(), /no Anthropic OAuth credential/)
  } finally {
    rmSync(path, { force: true })
  }
})

test("createAnthropicStore builds a file-backed store and requires auth_path", () => {
  const path = withAuthFile({ anthropic: { type: "oauth", refresh: "r", access: "a", expires: future() } })
  try {
    assert.ok(createAnthropicStore({ authPath: path }) instanceof FileTokenStore)
    assert.throws(() => createAnthropicStore({}), /requires auth_path/)
  } finally {
    rmSync(path, { force: true })
  }
})
