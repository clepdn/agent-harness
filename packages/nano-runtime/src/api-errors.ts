import { createHash } from "node:crypto"

export type ApiErrorContext = {
  provider: string
  model: string
  baseUrl: string
  role: "primary" | "fallback"
}

export type ClassifiedApiError = ApiErrorContext & {
  code: string
  status: number | null
  terminal: boolean
  fingerprint: string
  summary: string
  guidance: string | null
}

const TERMINAL_CODES = new Map<string, string>([
  ["refresh_token_invalidated", "Sign in to Codex again on the API bridge host."],
  ["invalid_api_key", "Replace or re-authorize the configured API credential."],
  ["authentication_error", "Re-authorize the provider credential."],
  ["permission_denied", "Check the credential's account and model permissions."],
  ["account_deactivated", "Check the provider account status."],
])

function extractCode(message: string): string {
  const jsonStyle = message.match(/["']code["']\s*:\s*["']([a-z0-9_-]+)["']/i)?.[1]
  if (jsonStyle) return jsonStyle.toLowerCase()
  const named = message.match(/\b(refresh_token_invalidated|invalid_api_key|authentication_error|permission_denied|account_deactivated)\b/i)?.[1]
  return named?.toLowerCase() ?? "unknown_api_error"
}

function extractStatus(message: string): number | null {
  const match = message.match(/\b([45]\d{2})\b/)
  return match ? Number.parseInt(match[1]!, 10) : null
}

function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.toLowerCase()
  } catch {
    return baseUrl.trim().toLowerCase().replace(/\?.*$/, "").slice(0, 160)
  }
}

function normalizedSignature(message: string): string {
  return message
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "<uuid>")
    .replace(/\b\d{4,}\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500)
}

export function classifyApiError(message: string, context: ApiErrorContext): ClassifiedApiError {
  const code = extractCode(message)
  const status = extractStatus(message)
  const guidance = TERMINAL_CODES.get(code) ?? null
  const signature = code === "unknown_api_error" ? normalizedSignature(message) : code
  const fingerprint = createHash("sha256")
    .update(`${context.provider.toLowerCase()}\n${endpointHost(context.baseUrl)}\n${signature}`)
    .digest("hex")

  return {
    ...context,
    code,
    status,
    terminal: guidance !== null,
    fingerprint,
    summary: message,
    guidance,
  }
}
