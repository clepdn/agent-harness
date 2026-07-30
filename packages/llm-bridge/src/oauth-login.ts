// Interactive OAuth logins for the admin UI.
//
// The bridge normally only *consumes* credentials that some CLI (`pi`, `codex
// login`) left on disk. This module lets the admin UI mint them instead, using
// pi-ai's flows so the client ids, scopes, PKCE, and token endpoints stay in
// one place — ours would rot the moment a provider rotated theirs.
//
// Two shapes, because the providers offer different things to a headless host:
//
//   anthropic — authorization code + PKCE. pi-ai spins up a callback server on
//     localhost:53692, which is useless when the bridge and the browser are on
//     different machines, so we always drive the manual-code path: hand the
//     user an authorize URL, take back the pasted code.
//
//   codex — RFC 8628 device code. Strictly better here: no callback server, no
//     pasting. Show a short user code, poll in the background until the user
//     finishes in their browser.
//
// A login is therefore a small state machine that outlives a single HTTP
// request. Sessions live in memory only; a bridge restart abandons them.

import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { loginAnthropic, loginOpenAICodexDeviceCode } from "@earendil-works/pi-ai/oauth"
import type { OAuthCredentials } from "@earendil-works/pi-ai"
import {
  deleteOAuthCredential,
  readOAuthCredential,
  writeOAuthCredential,
  type OAuthCredential,
} from "./anthropic-oauth"
import { resolveCodexAuthPath } from "./codex"
import {
  deleteCodexCredential,
  readCodexCredential,
  writeCodexCredential,
  type CodexCredentialInfo,
} from "./codex-auth"
import type { BridgeConfig } from "./config"

export type LoginProviderId = "anthropic" | "codex"

/** How the user completes the flow — the UI renders one or the other. */
export type LoginKind = "paste" | "device"

export type LoginSession = {
  id: string
  provider: LoginProviderId
  kind: LoginKind
  status: "awaiting_code" | "polling" | "complete" | "error"
  createdAt: number
  expiresAt: number
  /** paste flow: where to send the user. */
  authUrl?: string
  /** device flow: what to show them. */
  userCode?: string
  verificationUri?: string
  error?: string
  /** paste flow: resolves the pasted code into the pending login. */
  submitCode?: (code: string) => void
  /** paste flow: aborts the pending login (and frees the callback server). */
  failCode?: (err: Error) => void
  /** device flow: cancels polling. */
  abort?: AbortController
  /** Resolves once the underlying login promise has settled and released its
   *  resources (notably anthropic's callback port). */
  settled?: Promise<void>
}

/** The public view of a session — never leaks resolvers or tokens. */
export type LoginSessionView = Omit<LoginSession, "submitCode" | "failCode" | "abort" | "settled">

const SESSION_TTL_MS = 10 * 60 * 1000

const sessions = new Map<string, LoginSession>()

export function publicSession(session: LoginSession): LoginSessionView {
  const { submitCode: _s, failCode: _f, abort: _a, settled: _p, ...view } = session
  return view
}

export function getSession(id: string): LoginSession | undefined {
  return sessions.get(id)
}

/**
 * Drop sessions past their TTL, cancelling the flow behind each one. Anthropic
 * holds localhost:53692 for the life of its login promise, so an abandoned
 * session would block every later attempt until the bridge restarted.
 */
export function reapSessions(now: number = Date.now()): void {
  for (const [id, session] of sessions) {
    if (now < session.expiresAt) continue
    if (session.status === "awaiting_code" || session.status === "polling") {
      cancelSession(session, "login timed out")
    }
    if (now > session.expiresAt + SESSION_TTL_MS) sessions.delete(id)
  }
}

/**
 * Reap on a timer as well as on request. Without this, a login abandoned
 * halfway keeps its promise pending — and with it anthropic's callback port —
 * until somebody happens to open /admin again, which on a bridge that mostly
 * serves inference could be days. Unref'd so it never holds the process open.
 */
export function startSessionReaper(intervalMs = 60_000): NodeJS.Timeout {
  const timer = setInterval(() => reapSessions(), intervalMs)
  timer.unref()
  return timer
}

function cancelSession(session: LoginSession, reason: string): void {
  session.status = "error"
  session.error = reason
  session.failCode?.(new Error(reason))
  session.abort?.abort()
}

/**
 * Cancel a login and wait for it to release its resources before reporting
 * done, so a cancel immediately followed by a retry can't collide on the
 * anthropic callback port.
 */
export async function cancelLogin(id: string): Promise<boolean> {
  const session = sessions.get(id)
  if (!session) return false
  cancelSession(session, "cancelled")
  sessions.delete(id)
  await session.settled
  return true
}

// ── Credential locations ─────────────────────────────────────────────────────

/**
 * Mutable state for rotating credentials. The systemd unit sets
 * WorkingDirectory=/var/lib/llm-bridge, but don't rely on cwd: a token that
 * lands in the wrong directory looks like a login that silently did nothing.
 */
export function stateDir(): string {
  const fromEnv = process.env.STATE_DIRECTORY?.split(":")[0]?.trim() || process.env.BRIDGE_STATE_DIR?.trim()
  return fromEnv || path.join(os.homedir(), ".local", "share", "llm-bridge")
}

/**
 * Providers whose `auth_path` holds something other than an Anthropic OAuth
 * credential, so scanning for one never picks up their file by mistake.
 */
export const NON_ANTHROPIC_AUTH_PROVIDERS = new Set(["codex", "antigravity"])

/**
 * Where the anthropic credential lives. An explicit `auth_path` wins so an
 * existing shared ~/.pi/auth.json keeps working; otherwise the state dir. Note
 * this must be writable — tokens rotate in place on every refresh — so an
 * agenix path will not work here.
 */
export function resolveAnthropicAuthPath(config: BridgeConfig): string {
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.auth_path && !NON_ANTHROPIC_AUTH_PROVIDERS.has(name)) return provider.auth_path
  }
  return path.join(stateDir(), "auth", "anthropic.json")
}

/**
 * Point the config at a credential this UI just created. `discoverModels` only
 * walks `config.providers`, so a login for a provider the TOML never mentioned
 * would otherwise write a perfectly good token that nothing ever reads.
 */
export function registerProvider(config: BridgeConfig, provider: LoginProviderId, authPath: string): void {
  const name = provider === "anthropic" ? "anthropic-oauth" : "codex"
  const existing = config.providers[name]
  if (existing) {
    existing.auth_path ??= authPath
    return
  }
  config.providers[name] = { auth_path: authPath }
}

export function resolveAuthPath(config: BridgeConfig, provider: LoginProviderId): string {
  return provider === "anthropic"
    ? resolveAnthropicAuthPath(config)
    : resolveCodexAuthPath(config.providers["codex"])
}

// ── Status ───────────────────────────────────────────────────────────────────

export type ProviderStatus = {
  id: LoginProviderId
  name: string
  kind: LoginKind
  authPath: string
  connected: boolean
  /**
   * Access-token expiry in ms since epoch. Passing it means the next request
   * refreshes, not that the login is dead — the refresh token outlives it.
   */
  expiresAt?: number
  accountId?: string
  error?: string
}

export function providerStatus(config: BridgeConfig, provider: LoginProviderId): ProviderStatus {
  const authPath = resolveAuthPath(config, provider)
  const base = {
    id: provider,
    name: provider === "anthropic" ? "Claude Pro/Max" : "ChatGPT Plus/Pro (Codex)",
    kind: (provider === "anthropic" ? "paste" : "device") as LoginKind,
    authPath,
  }

  try {
    if (provider === "anthropic") {
      const cred = readOAuthCredential(authPath)
      return cred ? { ...base, connected: true, expiresAt: cred.expires } : { ...base, connected: false }
    }
    const info: CodexCredentialInfo | null = readCodexCredential(authPath)
    return info
      ? {
          ...base,
          connected: true,
          ...(info.accountId ? { accountId: info.accountId } : {}),
          ...(info.expiresAt ? { expiresAt: info.expiresAt } : {}),
        }
      : { ...base, connected: false }
  } catch (err) {
    // A malformed credential file is "not connected, and here's why" — the UI
    // needs to distinguish it from a fresh install to be worth anything.
    return { ...base, connected: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function logout(config: BridgeConfig, provider: LoginProviderId): void {
  const authPath = resolveAuthPath(config, provider)
  // Remove just our entry; the file may hold other providers' credentials.
  if (provider === "anthropic") deleteOAuthCredential(authPath)
  else deleteCodexCredential(authPath)
}

// ── Flows ────────────────────────────────────────────────────────────────────

/**
 * Abandon any in-flight login for this provider and wait for it to let go.
 * Anthropic's flow holds localhost:53692 until its promise settles, so a second
 * attempt started too eagerly fails on EADDRINUSE — cancelling is not enough,
 * we have to await the teardown. Pressing "sign in" again plainly means "forget
 * the last one", not "run two at once".
 */
async function supersede(provider: LoginProviderId): Promise<void> {
  const draining: Array<Promise<void>> = []
  for (const [id, session] of sessions) {
    if (session.provider !== provider) continue
    if (session.status === "awaiting_code" || session.status === "polling") {
      cancelSession(session, "superseded by a newer login")
      if (session.settled) draining.push(session.settled)
    }
    sessions.delete(id)
  }
  await Promise.all(draining)
}

function newSession(provider: LoginProviderId, kind: LoginKind): LoginSession {
  reapSessions()
  const now = Date.now()
  return {
    id: randomUUID(),
    provider,
    kind,
    status: kind === "paste" ? "awaiting_code" : "polling",
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  }
}

/**
 * Begin a login. Resolves once there is something to show the user — an
 * authorize URL, or a device code — not when the login completes.
 */
export async function startLogin(
  config: BridgeConfig,
  provider: LoginProviderId,
  onCredentials: () => Promise<void>,
): Promise<LoginSessionView> {
  return provider === "anthropic"
    ? startAnthropicLogin(config, onCredentials)
    : startCodexLogin(config, onCredentials)
}

async function startAnthropicLogin(
  config: BridgeConfig,
  onCredentials: () => Promise<void>,
): Promise<LoginSessionView> {
  await supersede("anthropic")
  const session = newSession("anthropic", "paste")

  // pi-ai reports the authorize URL through a callback partway into login(),
  // so bridge it to a promise: the HTTP response can't be sent until we have it.
  let announceUrl: (url: string) => void
  const authUrl = new Promise<string>((resolve) => {
    announceUrl = resolve
  })

  const code = new Promise<string>((resolve, reject) => {
    session.submitCode = resolve
    session.failCode = reject
  })

  const login = loginAnthropic({
    onAuth: (info) => announceUrl(info.url),
    onPrompt: () => code,
    onManualCodeInput: () => code,
  })

  // Surface a login that fails before it ever announces a URL (port 53692
  // already bound, network down) as a failed start rather than a hung request.
  const url = await Promise.race([
    authUrl,
    login.then(
      () => "",
      (err: unknown) => {
        throw err
      },
    ),
  ])

  session.authUrl = url
  sessions.set(session.id, session)

  session.settled = finishInBackground(session, login, async (creds) => {
    writeOAuthCredential(resolveAnthropicAuthPath(config), { ...creds, type: "oauth" } as OAuthCredential)
    await onCredentials()
  })

  return publicSession(session)
}

async function startCodexLogin(
  config: BridgeConfig,
  onCredentials: () => Promise<void>,
): Promise<LoginSessionView> {
  await supersede("codex")
  const session = newSession("codex", "device")
  session.abort = new AbortController()

  let announceCode: (info: { userCode: string; verificationUri: string; expiresInSeconds?: number }) => void
  const deviceCode = new Promise<{ userCode: string; verificationUri: string; expiresInSeconds?: number }>(
    (resolve) => {
      announceCode = resolve
    },
  )

  const login = loginOpenAICodexDeviceCode({
    onDeviceCode: (info) => announceCode(info),
    signal: session.abort.signal,
  })

  const info = await Promise.race([
    deviceCode,
    login.then(
      () => {
        throw new Error("codex device login completed without issuing a code")
      },
      (err: unknown) => {
        throw err
      },
    ),
  ])

  session.userCode = info.userCode
  session.verificationUri = info.verificationUri
  // The device code, not our TTL, bounds this flow.
  if (info.expiresInSeconds) session.expiresAt = Date.now() + info.expiresInSeconds * 1000
  sessions.set(session.id, session)

  session.settled = finishInBackground(session, login, async (creds) => {
    writeCodexCredential(resolveCodexAuthPath(config.providers["codex"]), creds)
    await onCredentials()
  })

  return publicSession(session)
}

/**
 * Park the login promise. Both flows settle long after the request that started
 * them, so the UI learns the outcome by polling the session.
 */
async function finishInBackground(
  session: LoginSession,
  login: Promise<OAuthCredentials>,
  persist: (creds: OAuthCredentials) => Promise<void>,
): Promise<void> {
  try {
    const creds = await login
    await persist(creds)
    session.status = "complete"
    console.log(`[bridge] ${session.provider} login complete`)
  } catch (err) {
    // Don't clobber an explicit cancel/timeout with the abort error it caused.
    if (session.status !== "error") {
      session.status = "error"
      session.error = err instanceof Error ? err.message : String(err)
    }
    console.error(`[bridge] ${session.provider} login failed: ${session.error}`)
  }
}
