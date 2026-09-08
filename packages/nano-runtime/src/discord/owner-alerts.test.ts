import assert from "node:assert/strict"
import test from "node:test"
import { classifyApiError } from "../api-errors"
import { config } from "../config"
import { getDb, initDb } from "../db"
import {
  configureOwnerAlertSender,
  handleOwnerAlertButton,
  reportApiError,
} from "./owner-alerts"

function failure(message: string, terminal = true) {
  return classifyApiError(
    terminal ? `${message} {"code":"refresh_token_invalidated"}` : message,
    {
      provider: "openai",
      model: "codex-test",
      baseUrl: "https://bridge.example.test/v1",
      role: "primary",
    },
  )
}

test("owner alert sends once and the owner can mute its fingerprint forever", async (t) => {
  initDb(":memory:")
  const previousOwner = config.discord.owner_id
  config.discord.owner_id = "owner"
  t.after(() => {
    config.discord.owner_id = previousOwner
    configureOwnerAlertSender(null)
  })

  const sent: any[] = []
  configureOwnerAlertSender(async (payload) => { sent.push(payload) })
  const error = failure("Authorization: Bearer extremely-secret-value")

  await reportApiError(error)
  assert.equal(sent.length, 1)
  assert.doesNotMatch(String(sent[0].content), /extremely-secret-value/)
  assert.match(String(sent[0].content), /\[redacted\]/)

  const row = sent[0].components[0].toJSON()
  const customId = row.components[0].custom_id
  let update: any = null
  await handleOwnerAlertButton({
    customId,
    user: { id: "owner" },
    update: async (value: unknown) => { update = value },
    reply: async () => { throw new Error("unexpected reply") },
  } as any)

  assert.ok(update)
  assert.equal(update.components[0].toJSON().components[0].disabled, true)
  const stored = getDb().prepare(
    "select muted_at, muted_by from owner_api_alerts where fingerprint = ?",
  ).get(error.fingerprint) as { muted_at: string | null; muted_by: string | null }
  assert.ok(stored.muted_at)
  assert.equal(stored.muted_by, "owner")

  await reportApiError(error)
  assert.equal(sent.length, 1, "muted fingerprints must not notify again")
})

test("transient errors notify only after three matching occurrences", async (t) => {
  initDb(":memory:")
  const previousOwner = config.discord.owner_id
  config.discord.owner_id = "owner"
  t.after(() => {
    config.discord.owner_id = previousOwner
    configureOwnerAlertSender(null)
  })

  const sent: any[] = []
  configureOwnerAlertSender(async (payload) => { sent.push(payload) })
  const error = failure("503 upstream temporarily unavailable", false)

  await reportApiError(error)
  await reportApiError(error)
  assert.equal(sent.length, 0)
  await reportApiError(error)
  assert.equal(sent.length, 1)
  assert.match(String(sent[0].content), /occurrences:\*\* 3/)
})

test("non-owner button clicks cannot mute alerts", async (t) => {
  initDb(":memory:")
  const previousOwner = config.discord.owner_id
  config.discord.owner_id = "owner"
  t.after(() => { config.discord.owner_id = previousOwner })

  let reply: any = null
  await handleOwnerAlertButton({
    customId: `owner-api-alert:mute:${"a".repeat(64)}`,
    user: { id: "intruder" },
    update: async () => { throw new Error("unexpected update") },
    reply: async (value: unknown) => { reply = value },
  } as any)

  assert.equal(reply.ephemeral, true)
  assert.match(reply.content, /not authorized/)
})
