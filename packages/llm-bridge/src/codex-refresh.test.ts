import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { getCodexAccessToken } from "./codex"

/** A JWT whose exp is `secondsFromNow`; only the payload is ever decoded. */
function jwt(secondsFromNow: number, accountId = "acct_test"): string {
  const payload = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + secondsFromNow,
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url")
  return `header.${payload}.signature`
}

function authFile(tokens: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-refresh-"))
  const authPath = path.join(dir, "auth.json")
  fs.writeFileSync(authPath, JSON.stringify({ tokens }))
  return authPath
}

test("concurrent requests on an expiring token refresh exactly once", async () => {
  // Every request re-reads auth.json and refreshes when the access token is
  // within 60s of expiry. Without serialisation, N in-flight requests all
  // present the same refresh token to the token endpoint. OpenAI rotates
  // refresh tokens (codex.ts stores next.refresh_token), and reuse detection
  // on a rotating credential can invalidate the whole chain — turning a burst
  // of traffic at the wrong moment into a forced re-login.
  const authPath = authFile({ access_token: jwt(-10), refresh_token: "refresh-0" })

  let exchanges = 0
  const seen: string[] = []
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    exchanges += 1
    seen.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "")
    // Let every concurrent caller get past the read before any write lands.
    await new Promise((r) => setTimeout(r, 25))
    return {
      ok: true,
      json: async () => ({ access_token: jwt(3600), refresh_token: `rotated-${exchanges}` }),
    }
  }) as unknown as typeof fetch

  const results = await Promise.all(
    Array.from({ length: 5 }, () => getCodexAccessToken(authPath, fetchImpl)),
  )

  assert.equal(exchanges, 1, `expected one token exchange, got ${exchanges} presenting ${JSON.stringify(seen)}`)
  // Every caller gets the same freshly minted token.
  assert.equal(new Set(results.map((r) => r.token)).size, 1)

  const onDisk = JSON.parse(fs.readFileSync(authPath, "utf-8"))
  assert.equal(onDisk.tokens.refresh_token, "rotated-1")
  fs.rmSync(path.dirname(authPath), { recursive: true, force: true })
})

test("a still-valid token is served without hitting the network", async () => {
  const authPath = authFile({ access_token: jwt(3600), refresh_token: "refresh-0" })
  const fetchImpl = (async () => {
    throw new Error("must not refresh a token that is still good")
  }) as unknown as typeof fetch

  const { token, accountId } = await getCodexAccessToken(authPath, fetchImpl)
  assert.ok(token)
  assert.equal(accountId, "acct_test")
  fs.rmSync(path.dirname(authPath), { recursive: true, force: true })
})

test("a failed refresh does not wedge later attempts", async () => {
  // A long-running bridge must recover on its own once the upstream stops
  // erroring; a rejected refresh left in the serialising chain would otherwise
  // poison every request behind it.
  const authPath = authFile({ access_token: jwt(-10), refresh_token: "refresh-0" })

  let calls = 0
  const fetchImpl = (async () => {
    calls += 1
    if (calls === 1) return { ok: false, status: 500, text: async () => "upstream boom" }
    return { ok: true, json: async () => ({ access_token: jwt(3600), refresh_token: "rotated" }) }
  }) as unknown as typeof fetch

  await assert.rejects(() => getCodexAccessToken(authPath, fetchImpl), /refresh failed/i)
  const { token } = await getCodexAccessToken(authPath, fetchImpl)
  assert.ok(token, "the store must recover after a transient failure")
  fs.rmSync(path.dirname(authPath), { recursive: true, force: true })
})

test("refreshes are serialised per credential file, not globally", async () => {
  // Two providers pointing at different files must not queue behind each other.
  const a = authFile({ access_token: jwt(-10), refresh_token: "a-0" })
  const b = authFile({ access_token: jwt(-10), refresh_token: "b-0" })

  const presented: string[] = []
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    presented.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "")
    await new Promise((r) => setTimeout(r, 10))
    return { ok: true, json: async () => ({ access_token: jwt(3600) }) }
  }) as unknown as typeof fetch

  await Promise.all([getCodexAccessToken(a, fetchImpl), getCodexAccessToken(b, fetchImpl)])
  assert.deepEqual(presented.sort(), ["a-0", "b-0"])

  fs.rmSync(path.dirname(a), { recursive: true, force: true })
  fs.rmSync(path.dirname(b), { recursive: true, force: true })
})
