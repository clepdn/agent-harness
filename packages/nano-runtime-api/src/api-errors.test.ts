import assert from "node:assert/strict"
import test from "node:test"
import { classifyApiError } from "./api-errors"

const context = {
  provider: "openai",
  model: "codex",
  baseUrl: "https://bridge.example.test/v1",
  role: "primary" as const,
}

test("classifies an embedded invalidated refresh token as terminal despite outer 500", () => {
  const error = classifyApiError(
    `500 Codex OAuth refresh failed (401): {
      "error": {
        "message": "Your refresh token has been invalidated. Please try signing in again.",
        "type": "invalid_request_error",
        "code": "refresh_token_invalidated"
      }
    }`,
    context,
  )

  assert.equal(error.status, 500)
  assert.equal(error.code, "refresh_token_invalidated")
  assert.equal(error.terminal, true)
  assert.match(error.guidance ?? "", /sign in/i)
  assert.match(error.fingerprint, /^[a-f0-9]{64}$/)
})

test("stable error codes produce stable fingerprints across changing prose", () => {
  const first = classifyApiError('500 wrapper: {"code":"refresh_token_invalidated","message":"first"}', context)
  const second = classifyApiError('500 wrapper: {"code":"refresh_token_invalidated","message":"second"}', {
    ...context,
    role: "fallback",
    model: "another-codex-model",
  })

  assert.equal(first.fingerprint, second.fingerprint)
})

test("ordinary server errors remain transient", () => {
  const error = classifyApiError("503 upstream temporarily unavailable", context)
  assert.equal(error.status, 503)
  assert.equal(error.terminal, false)
  assert.equal(error.code, "unknown_api_error")
})
