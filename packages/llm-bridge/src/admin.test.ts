import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Fastify from "fastify"
import { registerAdminRoutes } from "./admin"
import { loadApiKeys, type ApiKeyEntry } from "./auth"
import { logout, providerStatus, resolveAnthropicAuthPath, registerProvider, stateDir } from "./oauth-login"
import { readCodexCredential, writeCodexCredential } from "./codex-auth"
import { readOAuthCredential, writeOAuthCredential } from "./anthropic-oauth"
import type { BridgeConfig } from "./config"

const ADMIN_KEY = "11111111-2222-4333-8444-555555555555"
const PLAIN_KEY = "99999999-8888-4777-8666-555555555555"

const tmpDirs: string[] = []

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-admin-"))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function keys(entries: Array<Partial<ApiKeyEntry> & { key: string }>): Map<string, ApiKeyEntry> {
  return new Map(
    entries.map((e) => [
      e.key,
      { key: e.key, allowedModels: e.allowedModels ?? ["*"], caps: e.caps ?? [] } satisfies ApiKeyEntry,
    ]),
  )
}

function makeApp(apiKeys: Map<string, ApiKeyEntry>, config?: Partial<BridgeConfig>) {
  const full: BridgeConfig = {
    port: 0,
    host: "127.0.0.1",
    providers: {},
    models: {},
    ...config,
  }
  const app = Fastify({ logger: false })
  registerAdminRoutes(app, full, apiKeys, async () => {})
  return { app, config: full }
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` })

// ── capability gating ─────────────────────────────────────────────────────────
// /admin is proxied to the public internet along with the rest of :4040, so
// these are the only thing standing in front of the credential routes.

test("a valid key without the admin cap is refused", async () => {
  const { app } = makeApp(keys([{ key: PLAIN_KEY, allowedModels: ["*"] }]))
  const res = await app.inject({ method: "GET", url: "/admin/api/providers", headers: bearer(PLAIN_KEY) })
  assert.equal(res.statusCode, 403)
  assert.match(res.json().error.message, /admin/)
})

test("an unknown key is refused", async () => {
  const { app } = makeApp(keys([{ key: ADMIN_KEY, caps: ["admin"] }]))
  const res = await app.inject({
    method: "GET",
    url: "/admin/api/providers",
    headers: bearer("00000000-0000-4000-8000-000000000000"),
  })
  assert.equal(res.statusCode, 401)
})

test("a missing key is refused", async () => {
  const { app } = makeApp(keys([{ key: ADMIN_KEY, caps: ["admin"] }]))
  assert.equal((await app.inject({ method: "GET", url: "/admin/api/providers" })).statusCode, 401)
})

test("an open bridge is not an admin free-for-all", async () => {
  // No keys configured means loopback-only inference, but it must never mean
  // that an unauthenticated caller can re-auth the subscription accounts.
  const { app } = makeApp(new Map())
  const res = await app.inject({ method: "GET", url: "/admin/api/providers" })
  assert.equal(res.statusCode, 403)
})

test("allowedModels ['*'] does not imply the admin cap", async () => {
  const { app } = makeApp(keys([{ key: PLAIN_KEY, allowedModels: ["*"], caps: ["reader"] }]))
  assert.equal(
    (await app.inject({ method: "POST", url: "/admin/api/login/anthropic", headers: bearer(PLAIN_KEY) })).statusCode,
    403,
  )
})

test("every mutating admin route is gated", async () => {
  const { app } = makeApp(keys([{ key: PLAIN_KEY }]))
  const routes: Array<[string, string]> = [
    ["POST", "/admin/api/login/anthropic"],
    ["POST", "/admin/api/login/codex"],
    ["POST", "/admin/api/logout/anthropic"],
    ["GET", "/admin/api/session/whatever"],
    ["POST", "/admin/api/session/whatever/code"],
    ["DELETE", "/admin/api/session/whatever"],
  ]
  for (const [method, url] of routes) {
    const res = await app.inject({ method: method as any, url, headers: bearer(PLAIN_KEY) })
    assert.equal(res.statusCode, 403, `${method} ${url} should be gated`)
  }
})

test("an admin key reaches the providers list", async () => {
  const { app } = makeApp(keys([{ key: ADMIN_KEY, caps: ["admin"] }]))
  const res = await app.inject({ method: "GET", url: "/admin/api/providers", headers: bearer(ADMIN_KEY) })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(
    res.json().providers.map((p: { id: string }) => p.id),
    ["anthropic", "codex"],
  )
})

test("unknown providers 404 rather than starting a flow", async () => {
  const { app } = makeApp(keys([{ key: ADMIN_KEY, caps: ["admin"] }]))
  const res = await app.inject({ method: "POST", url: "/admin/api/login/antigravity", headers: bearer(ADMIN_KEY) })
  assert.equal(res.statusCode, 404)
})

// ── keys file ─────────────────────────────────────────────────────────────────

test("caps default to none and parse when present", () => {
  const dir = tmpDir()
  const file = path.join(dir, "keys.json")
  fs.writeFileSync(
    file,
    JSON.stringify([
      { key: ADMIN_KEY, allowedModels: ["*"], caps: ["admin"] },
      { key: PLAIN_KEY, allowedModels: ["*"] },
    ]),
  )
  const loaded = loadApiKeys(file)
  assert.deepEqual(loaded.get(ADMIN_KEY)?.caps, ["admin"])
  assert.deepEqual(loaded.get(PLAIN_KEY)?.caps, [])
})

test("a malformed caps field fails loudly instead of silently dropping admin", () => {
  const dir = tmpDir()
  const file = path.join(dir, "keys.json")
  fs.writeFileSync(file, JSON.stringify([{ key: ADMIN_KEY, allowedModels: ["*"], caps: "admin" }]))
  assert.throws(() => loadApiKeys(file), /caps/)
})

// ── credential round-trips ────────────────────────────────────────────────────

test("codex credentials are written in the CLI's shape, not pi-ai's", () => {
  // codex.ts and the real `codex` CLI both read auth.tokens.*; pi-ai's login
  // returns { access, refresh }. Persisting the wrong shape yields a login that
  // appears to succeed and then can't serve a single request.
  const authPath = path.join(tmpDir(), "auth.json")
  writeCodexCredential(authPath, { access: "access-tok", refresh: "refresh-tok", expires: 0 })

  const raw = JSON.parse(fs.readFileSync(authPath, "utf-8"))
  assert.equal(raw.tokens.access_token, "access-tok")
  assert.equal(raw.tokens.refresh_token, "refresh-tok")
  assert.ok(raw.last_refresh)
  assert.equal(fs.statSync(authPath).mode & 0o777, 0o600)
})

test("writing a codex credential preserves unrelated keys in the file", () => {
  const authPath = path.join(tmpDir(), "auth.json")
  fs.writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: "sk-keep-me", tokens: { id_token: "id" } }))
  writeCodexCredential(authPath, { access: "a", refresh: "r", expires: 0 })

  const raw = JSON.parse(fs.readFileSync(authPath, "utf-8"))
  assert.equal(raw.OPENAI_API_KEY, "sk-keep-me")
  assert.equal(raw.tokens.id_token, "id")
  assert.equal(raw.tokens.access_token, "a")
})

test("a codex credential with no access token reads as absent", () => {
  const authPath = path.join(tmpDir(), "auth.json")
  assert.equal(readCodexCredential(authPath), null)
  fs.writeFileSync(authPath, JSON.stringify({ tokens: { refresh_token: "r" } }))
  assert.equal(readCodexCredential(authPath), null)
})

test("anthropic credentials merge into a shared auth.json", () => {
  // The default path is ours, but pointing auth_path at a shared ~/.pi/auth.json
  // is supported and must not blow away another provider's entry.
  const authPath = path.join(tmpDir(), "auth.json")
  fs.writeFileSync(authPath, JSON.stringify({ openai: { type: "oauth", refresh: "keep", access: "x", expires: 1 } }))
  writeOAuthCredential(authPath, { type: "oauth", refresh: "r", access: "a", expires: 42 })

  const raw = JSON.parse(fs.readFileSync(authPath, "utf-8"))
  assert.equal(raw.openai.refresh, "keep")
  assert.equal(raw.anthropic.access, "a")
  assert.equal(readOAuthCredential(authPath)?.expires, 42)
  assert.equal(fs.statSync(authPath).mode & 0o777, 0o600)
})

test("credential files are created under a directory that does not exist yet", () => {
  // First login on a fresh host: StateDirectory exists but auth/ does not.
  const nested = path.join(tmpDir(), "auth", "anthropic.json")
  writeOAuthCredential(nested, { type: "oauth", refresh: "r", access: "a", expires: 1 })
  assert.ok(fs.existsSync(nested))
})

// ── path resolution ───────────────────────────────────────────────────────────

test("codex's auth_path is never mistaken for the anthropic credential", () => {
  // Both providers carry an auth_path holding different shapes; scanning for
  // "any provider with an auth_path" would hand back codex's file.
  const config: BridgeConfig = {
    port: 0,
    host: "127.0.0.1",
    providers: { codex: { auth_path: "/tmp/codex-auth.json" } },
    models: {},
  }
  assert.notEqual(resolveAnthropicAuthPath(config), "/tmp/codex-auth.json")
  assert.equal(resolveAnthropicAuthPath(config), path.join(stateDir(), "auth", "anthropic.json"))
})

test("an explicit anthropic auth_path wins over the state dir", () => {
  const config: BridgeConfig = {
    port: 0,
    host: "127.0.0.1",
    providers: { "anthropic-oauth": { auth_path: "/home/me/.pi/auth.json" } },
    models: {},
  }
  assert.equal(resolveAnthropicAuthPath(config), "/home/me/.pi/auth.json")
})

test("a login registers a provider the config never mentioned", () => {
  // discoverModels only walks config.providers, so without this the token is
  // written correctly and then never read.
  const config: BridgeConfig = { port: 0, host: "127.0.0.1", providers: {}, models: {} }
  registerProvider(config, "anthropic", "/state/auth/anthropic.json")
  assert.equal(config.providers["anthropic-oauth"]?.auth_path, "/state/auth/anthropic.json")

  registerProvider(config, "codex", "/state/auth/codex.json")
  assert.equal(config.providers["codex"]?.auth_path, "/state/auth/codex.json")
})

test("registering never overwrites an operator-configured auth_path", () => {
  const config: BridgeConfig = {
    port: 0,
    host: "127.0.0.1",
    providers: { codex: { auth_path: "/run/configured/codex.json" } },
    models: {},
  }
  registerProvider(config, "codex", "/state/auth/codex.json")
  assert.equal(config.providers["codex"]?.auth_path, "/run/configured/codex.json")
})

// ── concurrent logins ─────────────────────────────────────────────────────────

test("starting a second anthropic login supersedes the first", async () => {
  // pi-ai's anthropic flow holds localhost:53692 until its promise settles, so
  // back-to-back "sign in" clicks would fail on EADDRINUSE if the previous
  // attempt were merely abandoned rather than torn down and awaited.
  const { app } = makeApp(keys([{ key: ADMIN_KEY, caps: ["admin"] }]))

  const first = await app.inject({ method: "POST", url: "/admin/api/login/anthropic", headers: bearer(ADMIN_KEY) })
  assert.equal(first.statusCode, 200)

  const second = await app.inject({ method: "POST", url: "/admin/api/login/anthropic", headers: bearer(ADMIN_KEY) })
  assert.equal(second.statusCode, 200, "the port must have been released before the retry")
  assert.notEqual(second.json().id, first.json().id)

  // The superseded session is gone, not lingering as a live flow.
  const stale = await app.inject({
    method: "GET",
    url: `/admin/api/session/${first.json().id}`,
    headers: bearer(ADMIN_KEY),
  })
  assert.equal(stale.statusCode, 404)

  await app.inject({
    method: "DELETE",
    url: `/admin/api/session/${second.json().id}`,
    headers: bearer(ADMIN_KEY),
  })
})

test("a pasted code is rejected once the session is no longer awaiting one", async () => {
  const { app } = makeApp(keys([{ key: ADMIN_KEY, caps: ["admin"] }]))
  const started = await app.inject({ method: "POST", url: "/admin/api/login/anthropic", headers: bearer(ADMIN_KEY) })
  const id = started.json().id

  const send = () =>
    app.inject({
      method: "POST",
      url: `/admin/api/session/${id}/code`,
      headers: bearer(ADMIN_KEY),
      payload: { code: "abc#def" },
    })

  assert.equal((await send()).statusCode, 200)
  // Second submission races the first through the token exchange; refuse it.
  assert.equal((await send()).statusCode, 409)
})

test("an empty pasted code is refused", async () => {
  const { app } = makeApp(keys([{ key: ADMIN_KEY, caps: ["admin"] }]))
  const started = await app.inject({ method: "POST", url: "/admin/api/login/anthropic", headers: bearer(ADMIN_KEY) })
  const res = await app.inject({
    method: "POST",
    url: `/admin/api/session/${started.json().id}/code`,
    headers: bearer(ADMIN_KEY),
    payload: { code: "   " },
  })
  assert.equal(res.statusCode, 400)

  await app.inject({
    method: "DELETE",
    url: `/admin/api/session/${started.json().id}`,
    headers: bearer(ADMIN_KEY),
  })
})

test("a login session never exposes its resolvers", async () => {
  const { app } = makeApp(keys([{ key: ADMIN_KEY, caps: ["admin"] }]))
  const started = await app.inject({ method: "POST", url: "/admin/api/login/anthropic", headers: bearer(ADMIN_KEY) })
  const body = started.json()
  for (const leak of ["submitCode", "failCode", "abort", "settled"]) {
    assert.ok(!(leak in body), `${leak} must not be serialised to the client`)
  }

  await app.inject({ method: "DELETE", url: `/admin/api/session/${body.id}`, headers: bearer(ADMIN_KEY) })
})

// ── status ────────────────────────────────────────────────────────────────────

test("status reports connected once a credential lands", () => {
  const dir = tmpDir()
  const authPath = path.join(dir, "codex.json")
  const config: BridgeConfig = {
    port: 0,
    host: "127.0.0.1",
    providers: { codex: { auth_path: authPath } },
    models: {},
  }
  assert.equal(providerStatus(config, "codex").connected, false)

  writeCodexCredential(authPath, { access: "a", refresh: "r", expires: 0 })
  assert.equal(providerStatus(config, "codex").connected, true)
})

// ── sign-out ──────────────────────────────────────────────────────────────────

test("signing out of anthropic actually reads back as signed out", () => {
  // Blanking the fields instead of removing the entry left status reporting
  // connected with an empty refresh token, so every later request would attempt
  // a refresh and fail.
  const authPath = path.join(tmpDir(), "anthropic.json")
  const config: BridgeConfig = {
    port: 0,
    host: "127.0.0.1",
    providers: { "anthropic-oauth": { auth_path: authPath } },
    models: {},
  }
  writeOAuthCredential(authPath, { type: "oauth", refresh: "r", access: "a", expires: Date.now() + 3.6e6 })
  assert.equal(providerStatus(config, "anthropic").connected, true)

  logout(config, "anthropic")
  assert.equal(providerStatus(config, "anthropic").connected, false)
  assert.equal(readOAuthCredential(authPath), null)
})

test("signing out leaves other providers in a shared auth.json alone", () => {
  const authPath = path.join(tmpDir(), "auth.json")
  fs.writeFileSync(authPath, JSON.stringify({ "github-copilot": { type: "oauth", refresh: "keep", access: "k", expires: 1 } }))
  writeOAuthCredential(authPath, { type: "oauth", refresh: "r", access: "a", expires: 1 })

  const config: BridgeConfig = {
    port: 0,
    host: "127.0.0.1",
    providers: { "anthropic-oauth": { auth_path: authPath } },
    models: {},
  }
  logout(config, "anthropic")

  const raw = JSON.parse(fs.readFileSync(authPath, "utf-8"))
  assert.equal(raw["github-copilot"].refresh, "keep")
  assert.ok(!("anthropic" in raw))
})

test("signing out of codex clears the tokens but keeps unrelated keys", () => {
  const authPath = path.join(tmpDir(), "codex.json")
  fs.writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: "sk-keep-me" }))
  writeCodexCredential(authPath, { access: "a", refresh: "r", expires: 0 })

  const config: BridgeConfig = { port: 0, host: "127.0.0.1", providers: { codex: { auth_path: authPath } }, models: {} }
  assert.equal(providerStatus(config, "codex").connected, true)

  logout(config, "codex")
  assert.equal(providerStatus(config, "codex").connected, false)
  assert.equal(JSON.parse(fs.readFileSync(authPath, "utf-8")).OPENAI_API_KEY, "sk-keep-me")
})

test("an empty refresh token reads as absent, however it got there", () => {
  // Defensive half: a hand-edited or half-written file must not look valid.
  const authPath = path.join(tmpDir(), "anthropic.json")
  fs.writeFileSync(authPath, JSON.stringify({ anthropic: { type: "oauth", refresh: "", access: "", expires: 0 } }))
  assert.equal(readOAuthCredential(authPath), null)
})

test("signing out of a provider that was never signed in is a no-op", () => {
  const authPath = path.join(tmpDir(), "anthropic.json")
  const config: BridgeConfig = {
    port: 0,
    host: "127.0.0.1",
    providers: { "anthropic-oauth": { auth_path: authPath } },
    models: {},
  }
  assert.doesNotThrow(() => logout(config, "anthropic"))
  assert.equal(fs.existsSync(authPath), false)
})

test("a corrupt credential file reports an error rather than a clean 'not connected'", () => {
  const dir = tmpDir()
  const authPath = path.join(dir, "codex.json")
  fs.writeFileSync(authPath, "{ not json")
  const config: BridgeConfig = {
    port: 0,
    host: "127.0.0.1",
    providers: { codex: { auth_path: authPath } },
    models: {},
  }
  const status = providerStatus(config, "codex")
  assert.equal(status.connected, false)
  assert.ok(status.error, "a broken file must be distinguishable from a fresh install")
})
