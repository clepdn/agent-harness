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

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
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
    if (!existsSync(this.authPath)) return null
    const file = JSON.parse(readFileSync(this.authPath, "utf-8")) as AuthFile
    const entry = file?.[this.providerId]
    if (entry && entry.type === "oauth" && typeof (entry as Record<string, unknown>).refresh === "string") {
      return entry as unknown as OAuthCredential
    }
    return null
  }

  private writeCred(cred: OAuthCredential): void {
    let file: AuthFile = {}
    if (existsSync(this.authPath)) {
      try {
        file = JSON.parse(readFileSync(this.authPath, "utf-8")) as AuthFile
      } catch {
        file = {}
      }
    }
    file[this.providerId] = cred
    const tmp = `${this.authPath}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.authPath)
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
