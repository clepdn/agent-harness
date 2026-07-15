// Anthropic subscription OAuth — extracted from pi-ai's source.
// Manages token refresh for Claude Pro/Max subscription auth.

const CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl")
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"

export interface OAuthCredentials {
  refresh: string
  access: string
  expires: number // Unix timestamp in ms
}

/** Check if an API key is an OAuth token (Claude subscription). */
export function isOAuthToken(apiKey: string): boolean {
  return apiKey.includes("sk-ant-oat")
}

/** Check if credentials are expired or about to expire (5 min buffer). */
export function isExpired(creds: OAuthCredentials): boolean {
  return Date.now() >= creds.expires
}

/**
 * Refresh an Anthropic OAuth token using the refresh token.
 * Returns updated credentials with a new access token.
 */
export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  })

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`Anthropic token refresh failed (${resp.status}): ${text}`)
  }

  const data = await resp.json() as {
    access_token: string
    refresh_token: string
    expires_in: number
    scope?: string
  }

  return {
    refresh: data.refresh_token,
    access: data.access_token,
    // 5 minute buffer before actual expiry
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  }
}

/**
 * Token store — holds OAuth credentials in memory.
 * Automatically refreshes when the access token is expired.
 */
export class AnthropicTokenStore {
  private creds: OAuthCredentials | null = null

  constructor(credentials?: OAuthCredentials) {
    if (credentials) this.creds = credentials
  }

  /** Set initial credentials (e.g. from config). */
  setCredentials(creds: OAuthCredentials): void {
    this.creds = creds
  }

  /**
   * Get a valid access token, refreshing if necessary.
   * Returns the access token string suitable for use as an API key.
   */
  async getAccessToken(): Promise<string> {
    if (!this.creds) {
      throw new Error("[bridge] no Anthropic OAuth credentials configured")
    }

    if (isExpired(this.creds)) {
      console.log("[bridge] refreshing Anthropic OAuth token...")
      this.creds = await refreshAnthropicToken(this.creds.refresh)
      console.log("[bridge] token refreshed, expires at", new Date(this.creds.expires).toISOString())
    }

    return this.creds.access
  }

  /** Check if the store has credentials. */
  hasCredentials(): boolean {
    return this.creds !== null
  }
}

/**
 * Parse OAuth credentials from a config value.
 * Accepts either:
 * - A refresh token string (will refresh on first use)
 * - A JSON object { refresh, access, expires }
 */
export function parseOAuthCredentials(input: unknown): OAuthCredentials | null {
  if (typeof input === "string") {
    // Just a refresh token — access will be empty, will refresh on first use
    return { refresh: input, access: "", expires: 0 }
  }

  if (typeof input === "object" && input !== null) {
    const obj = input as Record<string, unknown>
    if (typeof obj.refresh === "string") {
      return {
        refresh: obj.refresh,
        access: typeof obj.access === "string" ? obj.access : "",
        expires: typeof obj.expires === "number" ? obj.expires : 0,
      }
    }
  }

  return null
}
