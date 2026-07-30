// Anthropic subscription OAuth (Claude Pro/Max).
//
// Credentials live in an on-disk auth file using pi-ai's auth.json shape —
// a map keyed by provider id, each value a type-tagged credential:
//
//   {
//     "anthropic": {
//       "type": "oauth",
//       "refresh": "...",
//       "access":  "...",
//       "expires": 1712345678901
//     }
//   }
//
// This is the same format pi-ai (and the coding-agent's AuthStorage) persists,
// so rotated refresh/access/expiry survive restarts and stay in sync with any
// other tool sharing the file. Token refresh itself is delegated to pi-ai's
// implementation — we do NOT re-derive the client id or token endpoint here.
//
// The file-backed store mirrors how the codex bridge treats ~/.codex/auth.json:
// read → refresh-if-expired → atomic write-back (tmp + rename, mode 0600).

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { refreshAnthropicToken } from "@earendil-works/pi-ai/oauth"
import type { OAuthCredentials } from "@earendil-works/pi-ai"

const DEFAULT_PROVIDER_ID = "anthropic"

/** pi-ai's type-tagged OAuth credential — the shape stored per provider. */
export interface OAuthCredential extends OAuthCredentials {
  type: "oauth"
}

/** The on-disk auth.json shape: one type-tagged credential per provider id. */
type AuthFile = Record<string, ({ type: string } & Record<string, unknown>) | undefined>

/** pi bakes a 5-minute buffer into `expires`; treat as expired at/after it. */
function isExpired(creds: OAuthCredentials): boolean {
  return Date.now() >= (creds.expires ?? 0)
}

/** Default auth file location (shared with pi): ~/.pi/auth.json. */
export function defaultAnthropicAuthPath(): string {
  return process.env.ANTHROPIC_AUTH_PATH?.trim() || join(homedir(), ".pi", "auth.json")
}

export interface TokenStore {
  getAccessToken(): Promise<string>
  hasCredentials(): boolean
}

/**
 * Read one provider's credential out of a pi-shaped auth.json, if present.
 *
 * The refresh token must be non-empty, not merely a string: an entry with a
 * blank refresh is unusable (every request would attempt a refresh and fail),
 * so it has to read as absent rather than as a credential.
 */
export function readOAuthCredential(
  authPath: string,
  providerId: string = DEFAULT_PROVIDER_ID,
): OAuthCredential | null {
  if (!existsSync(authPath)) return null
  const file = JSON.parse(readFileSync(authPath, "utf-8")) as AuthFile
  const entry = file?.[providerId]
  const refresh = entry && (entry as Record<string, unknown>).refresh
  if (entry && entry.type === "oauth" && typeof refresh === "string" && refresh.length > 0) {
    return entry as unknown as OAuthCredential
  }
  return null
}

/**
 * Remove one provider's credential, leaving the rest of a shared auth.json
 * intact. Deleting the entry rather than blanking its fields is what makes a
 * sign-out actually read back as signed out.
 */
export function deleteOAuthCredential(
  authPath: string,
  providerId: string = DEFAULT_PROVIDER_ID,
): void {
  if (!existsSync(authPath)) return
  let file: AuthFile
  try {
    file = JSON.parse(readFileSync(authPath, "utf-8")) as AuthFile
  } catch {
    return
  }
  if (!(providerId in file)) return
  delete file[providerId]
  const tmp = `${authPath}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, authPath)
}

/**
 * Merge one provider's credential into a pi-shaped auth.json, atomically and at
 * mode 0600. Other providers' entries in the same file are preserved, so this
 * stays safe to point at a shared ~/.pi/auth.json. A corrupt file is replaced
 * rather than inherited — refusing to write would strand the login.
 */
export function writeOAuthCredential(
  authPath: string,
  cred: OAuthCredential,
  providerId: string = DEFAULT_PROVIDER_ID,
): void {
  let file: AuthFile = {}
  if (existsSync(authPath)) {
    try {
      file = JSON.parse(readFileSync(authPath, "utf-8")) as AuthFile
    } catch {
      file = {}
    }
  }
  file[providerId] = cred
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 })
  const tmp = `${authPath}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, authPath)
}

/**
 * File-backed store. Reads pi's auth.json, refreshes on expiry, and writes the
 * rotated credential back atomically so refresh/access/expiry rotate in place.
 * Refreshes are serialized so concurrent requests can't double-refresh a
 * just-rotated token.
 */
export class FileTokenStore implements TokenStore {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly authPath: string,
    private readonly providerId: string = DEFAULT_PROVIDER_ID,
  ) {}

  private readCred(): OAuthCredential | null {
    return readOAuthCredential(this.authPath, this.providerId)
  }

  private writeCred(cred: OAuthCredential): void {
    writeOAuthCredential(this.authPath, cred, this.providerId)
  }

  hasCredentials(): boolean {
    try {
      return this.readCred() !== null
    } catch {
      return false
    }
  }

  getAccessToken(): Promise<string> {
    const next = this.chain.then(async () => {
      const cred = this.readCred()
      if (!cred) {
        throw new Error(`[bridge] no Anthropic OAuth credential for "${this.providerId}" in ${this.authPath}`)
      }
      if (!isExpired(cred)) return cred.access

      console.log(`[bridge] refreshing Anthropic OAuth token (${this.providerId})...`)
      const refreshed = await refreshAnthropicToken(cred.refresh)
      const rotated: OAuthCredential = { ...refreshed, type: "oauth" }
      this.writeCred(rotated)
      console.log(`[bridge] token refreshed, expires ${new Date(rotated.expires).toISOString()}`)
      return rotated.access
    })
    // Keep the chain alive even if this refresh rejects.
    this.chain = next.catch(() => {})
    return next
  }
}

/** Build a file-backed store for an anthropic-oauth provider's `auth_path`. */
export function createAnthropicStore(opts: {
  authPath?: string
  providerId?: string
}): TokenStore {
  if (!opts.authPath) {
    throw new Error("[bridge] anthropic-oauth provider requires auth_path")
  }
  return new FileTokenStore(opts.authPath, opts.providerId)
}
