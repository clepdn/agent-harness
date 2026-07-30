import { readFileSync, existsSync } from "node:fs"

export interface ApiKeyEntry {
  key: string           // UUID format, enforced
  name?: string         // optional human-readable name
  allowedModels: string[] // glob patterns: ["*"] = all, ["claude-*"] = claude models
  caps: string[]        // extra privileges beyond inference, e.g. ["admin"]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Validate that a string is a proper UUID. */
export function isValidUuid(s: string): boolean {
  return UUID_RE.test(s)
}

/** Convert a glob pattern to a RegExp. Supports * and ?. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "i")
}

/** Check if a model id matches any of the allowed model patterns. */
export function isModelAllowed(keyEntry: ApiKeyEntry, modelId: string): boolean {
  return keyEntry.allowedModels.some((pattern) => globToRegex(pattern).test(modelId))
}

/**
 * Check if a key carries a capability. Capabilities are exact strings, never
 * globs — `allowedModels: ["*"]` must not imply admin.
 */
export function hasCap(keyEntry: ApiKeyEntry, cap: string): boolean {
  return keyEntry.caps.includes(cap)
}

/**
 * Load API keys from a JSON file or argv.
 *
 * JSON format (array):
 * [
 *   { "key": "uuid-here", "allowedModels": ["*"], "name": "coral" },
 *   { "key": "uuid-here", "allowedModels": ["claude-*"], "name": "claude-only" },
 *   { "key": "uuid-here", "allowedModels": ["*"], "name": "me", "caps": ["admin"] }
 * ]
 *
 * Or single object.
 *
 * `caps` is optional and defaults to none. A key without "admin" cannot reach
 * /admin, no matter how broad its allowedModels are.
 */
export function loadApiKeys(keysPath?: string): Map<string, ApiKeyEntry> {
  const keys = new Map<string, ApiKeyEntry>()

  if (!keysPath || !existsSync(keysPath)) {
    return keys
  }

  const raw = readFileSync(keysPath, "utf-8")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`[bridge] invalid JSON in keys file: ${keysPath}`)
  }

  const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed]

  for (const entry of entries) {
    const e = entry as Record<string, unknown>
    const key = e.key
    if (typeof key !== "string" || !isValidUuid(key)) {
      throw new Error(`[bridge] invalid API key in keys file: expected UUID, got "${key}". use a proper UUID v4.`)
    }

    const allowedModels = e.allowedModels
    if (!Array.isArray(allowedModels)) {
      throw new Error(`[bridge] API key "${key}" has a malformed allowedModels field: expected an array`)
    }

    const caps = e.caps ?? []
    if (!Array.isArray(caps) || caps.some((c) => typeof c !== "string")) {
      throw new Error(`[bridge] API key "${key}" has a malformed caps field: expected an array of strings`)
    }

    const keyEntry: ApiKeyEntry = {
      key,
      allowedModels: allowedModels as string[],
      caps: caps as string[],
      ...(typeof e.name === "string" ? { name: e.name } : {}),
    }

    keys.set(key, keyEntry)
  }

  return keys
}

/**
 * Authenticate a request. Returns the matching key entry or null.
 */
export function authenticate(
  authHeader: string | undefined,
  apiKeys: Map<string, ApiKeyEntry>,
): ApiKeyEntry | null {
  if (!authHeader) return null
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : authHeader.trim()
  return apiKeys.get(token) ?? null
}

/**
 * Generate a new UUID for use as an API key.
 * Useful for creating key files.
 */
