import { readFileSync, existsSync } from "node:fs"
import { randomUUID } from "node:crypto"

export interface ApiKeyEntry {
  key: string           // UUID format, enforced
  name?: string         // optional human-readable name
  allowedModels: string[] // glob patterns: ["*"] = all, ["claude-*"] = claude models
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
 * Load API keys from a JSON file or argv.
 *
 * JSON format (array):
 * [
 *   { "key": "uuid-here", "allowedModels": ["*"], "name": "coral" },
 *   { "key": "uuid-here", "allowedModels": ["claude-*"], "name": "claude-only" }
 * ]
 *
 * Or single object.
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
    if (!Array.isArray(allowedModels) || allowedModels.length === 0) {
      throw new Error(`[bridge] API key "${key}" must have at least one allowedModels entry`)
    }

    const keyEntry: ApiKeyEntry = {
      key,
      allowedModels: allowedModels as string[],
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
  if (!authHeader.startsWith("Bearer ")) return null
  const token = authHeader.slice(7).trim()
  return apiKeys.get(token) ?? null
}

/**
 * Generate a new UUID for use as an API key.
 * Useful for creating key files.
 */
export function generateApiKey(): string {
  return randomUUID()
}
