// Reading and writing ~/.codex/auth.json.
//
// pi-ai's login returns its own credential shape ({ refresh, access, expires,
// accountId }), but codex.ts reads the codex CLI's shape
// ({ tokens: { access_token, refresh_token, account_id } }) — and so does the
// real `codex` CLI. We persist the CLI shape so the file stays interchangeable:
// a login here is visible to codex, and `codex login` is visible to us.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { OAuthCredentials } from "@earendil-works/pi-ai"

type CodexAuthFile = {
  tokens?: {
    access_token?: string
    refresh_token?: string
    account_id?: string
    id_token?: string
  }
  last_refresh?: string
  [key: string]: unknown
}

export type CodexCredentialInfo = {
  accountId?: string
  /** Access-token expiry (ms since epoch), decoded from the JWT. */
  expiresAt?: number
}

function decodeJwt(token: string): Record<string, any> | null {
  try {
    const payload = token.split(".")[1]
    return payload ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) : null
  } catch {
    return null
  }
}

function accountIdFromToken(token: string): string | undefined {
  return decodeJwt(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id
}

/** Present-and-usable check for the admin UI. Null means "log in". */
export function readCodexCredential(authPath: string): CodexCredentialInfo | null {
  if (!existsSync(authPath)) return null
  const file = JSON.parse(readFileSync(authPath, "utf-8")) as CodexAuthFile
  const access = file.tokens?.access_token?.trim()
  if (!access) return null
  const accountId = file.tokens?.account_id || accountIdFromToken(access)
  const exp = Number(decodeJwt(access)?.exp ?? 0)
  return {
    ...(accountId ? { accountId } : {}),
    ...(exp > 0 ? { expiresAt: exp * 1000 } : {}),
  }
}

/**
 * Drop the token block, leaving any unrelated keys (an OPENAI_API_KEY the CLI
 * stashed alongside, say) in place. Removing rather than blanking is what makes
 * a sign-out read back as signed out.
 */
export function deleteCodexCredential(authPath: string): void {
  if (!existsSync(authPath)) return
  let file: CodexAuthFile
  try {
    file = JSON.parse(readFileSync(authPath, "utf-8")) as CodexAuthFile
  } catch {
    return
  }
  if (!file.tokens) return
  delete file.tokens
  delete file.last_refresh
  const tmp = `${authPath}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, authPath)
}

/**
 * Write credentials in codex CLI shape, atomically at mode 0600. Preserves any
 * unrelated top-level keys the CLI may have left behind.
 */
export function writeCodexCredential(
  authPath: string,
  creds: OAuthCredentials & { accountId?: string },
): void {
  let file: CodexAuthFile = {}
  if (existsSync(authPath)) {
    try {
      file = JSON.parse(readFileSync(authPath, "utf-8")) as CodexAuthFile
    } catch {
      file = {}
    }
  }

  const accountId =
    creds.accountId || (creds.access ? accountIdFromToken(creds.access) : undefined) || file.tokens?.account_id

  file.tokens = {
    ...file.tokens,
    access_token: creds.access,
    refresh_token: creds.refresh,
    ...(accountId ? { account_id: accountId } : {}),
  }
  file.last_refresh = new Date().toISOString()

  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 })
  const tmp = `${authPath}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, authPath)
}
