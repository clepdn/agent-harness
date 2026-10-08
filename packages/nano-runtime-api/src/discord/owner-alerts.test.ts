import type { InteractionReplyOptions, InteractionUpdateOptions, MessageCreateOptions } from "discord.js"
import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { classifyApiError } from "../api-errors"
import { config } from "../config"
import { createDatabase } from "../db"
import { createOwnerAlerts } from "./owner-alerts"

function database(t: TestContext) {
  const db = createDatabase(":memory:").db
  t.after(() => db.close())
  return db
}

function failure(message: string, terminal = true) {
  return classifyApiError(
    terminal ? `${message} {"code":"refresh_token_invalidated"}` : message,
    { provider: "test", model: "test", baseUrl: "https://test.invalid", role: "primary" }
  )
}

test("owner alert sends once and the owner can mute its fingerprint forever", async (t) => {
  const db = database(t)
  const alerts = createOwnerAlerts()
  t.after(() => alerts.stop())
  const previousOwner = config.discord.owner_id
  config.discord.owner_id = "owner"
  t.after(() => { config.discord.owner_id = previousOwner })

  const sent: MessageCreateOptions[] = []
  alerts.setSender(async (payload) => { sent.push(payload) })
  const error = failure("Authorization: Bearer extremely-secret-value")

  await alerts.reportApiError(db, error)
  assert.equal(sent.length, 1)
  assert.doesNotMatch(String(sent[0]?.content), /extremely-secret-value/)
  assert.match(String(sent[0]?.content), /\[redacted\]/)

  const sentPayload = sent[0]
  assert.ok(sentPayload)
  const payload = JSON.parse(JSON.stringify(sentPayload)) as { components: Array<{ components: Array<{ custom_id: string }> }> }
  const customId = payload.components[0]?.components[0]?.custom_id
  assert.ok(customId)
  assert.equal(alerts.isButton({ customId, user: { id: "owner" }, update: async () => {}, reply: async () => {} }), true)
  const capturedUpdate: { value: InteractionUpdateOptions | null } = { value: null }
  await alerts.handleButton(db, {
    customId,
    user: { id: "owner" },
    update: async (value) => { capturedUpdate.value = value },
    reply: async () => { throw new Error("unexpected reply") },
  })

  assert.ok(capturedUpdate.value)
  const updated = JSON.parse(JSON.stringify(capturedUpdate.value)) as { components: Array<{ components: Array<{ disabled: boolean }> }> }
  assert.equal(updated.components[0]?.components[0]?.disabled, true)
  const stored = db.prepare("select muted_at, muted_by from owner_api_alerts where fingerprint = ?").get(error.fingerprint) as { muted_at: string | null; muted_by: string | null }
  assert.ok(stored.muted_at)
  assert.equal(stored.muted_by, "owner")

  await alerts.reportApiError(db, error)
  assert.equal(sent.length, 1, "muted fingerprints must not notify again")
})

test("transient errors notify only after three matching occurrences", async (t) => {
  const db = database(t)
  const alerts = createOwnerAlerts()
  t.after(() => alerts.stop())
  const previousOwner = config.discord.owner_id
  config.discord.owner_id = "owner"
  t.after(() => { config.discord.owner_id = previousOwner })
  const sent: Array<{ content?: string }> = []
  alerts.setSender(async (payload) => { sent.push(payload) })
  const error = failure("503 upstream temporarily unavailable", false)
  await alerts.reportApiError(db, error)
  await alerts.reportApiError(db, error)
  assert.equal(sent.length, 0)
  await alerts.reportApiError(db, error)
  assert.equal(sent.length, 1)
  assert.match(String(sent[0]?.content), /occurrences:\*\* 3/)
})

test("non-owner button clicks cannot mute alerts", async (t) => {
  const db = database(t)
  const alerts = createOwnerAlerts()
  t.after(() => alerts.stop())
  const previousOwner = config.discord.owner_id
  config.discord.owner_id = "owner"
  t.after(() => { config.discord.owner_id = previousOwner })

  const replyCapture: { value: InteractionReplyOptions | null } = { value: null }
  await alerts.handleButton(db, {
    customId: `owner-api-alert:mute:${"a".repeat(64)}`,
    user: { id: "intruder" },
    update: async () => { throw new Error("unexpected update") },
    reply: async (value) => { replyCapture.value = value },
  })

  assert.ok(replyCapture.value)
  assert.equal(replyCapture.value.ephemeral, true)
  assert.match(String(replyCapture.value.content), /not authorized/)
})
