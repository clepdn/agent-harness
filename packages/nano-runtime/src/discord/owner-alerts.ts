import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type MessageCreateOptions,
} from "discord.js"
import { config, redactSecrets } from "../config"
import { getDb } from "../db"
import type { ClassifiedApiError } from "../api-errors"

const BUTTON_PREFIX = "owner-api-alert:mute:"
const REPEAT_NOTIFICATION_MS = 6 * 60 * 60 * 1000
const TRANSIENT_NOTIFICATION_THRESHOLD = 3

type OwnerAlertSender = (payload: MessageCreateOptions) => Promise<void>

type AlertRow = {
  occurrence_count: number
  last_notified_at: string | null
  muted_at: string | null
}

let sender: OwnerAlertSender | null = null
let queue = Promise.resolve()

export function configureOwnerAlertSender(next: OwnerAlertSender | null): void {
  sender = next
}

function safeSummary(text: string): string {
  return redactSecrets(text)
    .replace(/(authorization\s*:\s*bearer)\s+\S+/gi, "$1 [redacted]")
    .replace(/(["'](?:access|refresh|api)[_-]?token["']\s*:\s*["'])[^"']+/gi, "$1[redacted]")
    .replace(/```/g, "'''")
    .slice(0, 900)
}

function alertPayload(error: ClassifiedApiError, count: number): MessageCreateOptions {
  const lines = [
    "**API error needs attention**",
    `**code:** \`${error.code}\``,
    `**model:** \`${error.model}\` (${error.role})`,
    `**provider:** \`${error.provider}\``,
    `**occurrences:** ${count}`,
  ]
  if (error.guidance) lines.push(`**action:** ${error.guidance}`)
  lines.push("", "```text", safeSummary(error.summary), "```")

  const button = new ButtonBuilder()
    .setCustomId(`${BUTTON_PREFIX}${error.fingerprint}`)
    .setLabel("Mute this error forever")
    .setStyle(ButtonStyle.Secondary)

  return {
    content: lines.join("\n"),
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
  }
}

function shouldNotify(error: ClassifiedApiError, row: AlertRow, nowMs: number): boolean {
  if (row.muted_at) return false
  if (!error.terminal && row.occurrence_count < TRANSIENT_NOTIFICATION_THRESHOLD) return false
  if (!row.last_notified_at) return true
  return nowMs - Date.parse(row.last_notified_at) >= REPEAT_NOTIFICATION_MS
}

async function recordAndNotify(error: ClassifiedApiError): Promise<void> {
  try {
    const db = getDb()
    const now = new Date()
    const nowIso = now.toISOString()
    db.prepare(
      `insert into owner_api_alerts (
         fingerprint, error_code, first_seen_at, last_seen_at, occurrence_count
       ) values (?, ?, ?, ?, 1)
       on conflict(fingerprint) do update set
         error_code = excluded.error_code,
         last_seen_at = excluded.last_seen_at,
         occurrence_count = owner_api_alerts.occurrence_count + 1`,
    ).run(error.fingerprint, error.code, nowIso, nowIso)

    const row = db.prepare(
      `select occurrence_count, last_notified_at, muted_at
       from owner_api_alerts where fingerprint = ?`,
    ).get(error.fingerprint) as AlertRow

    if (!sender || !config.discord.owner_id || !shouldNotify(error, row, now.getTime())) return

    await sender(alertPayload(error, row.occurrence_count))
    db.prepare(
      "update owner_api_alerts set last_notified_at = ? where fingerprint = ?",
    ).run(nowIso, error.fingerprint)
  } catch (err) {
    console.warn("[owner alert] failed:", err instanceof Error ? err.message : String(err))
  }
}

/** Records an API failure and queues a best-effort Discord notification. */
export function reportApiError(error: ClassifiedApiError): Promise<void> {
  const pending = queue.then(() => recordAndNotify(error))
  queue = pending.catch(() => {})
  return pending
}

export function isOwnerAlertButton(interaction: ButtonInteraction): boolean {
  return interaction.customId.startsWith(BUTTON_PREFIX)
}

export async function handleOwnerAlertButton(interaction: ButtonInteraction): Promise<void> {
  if (interaction.user.id !== config.discord.owner_id) {
    await interaction.reply({ content: "you are not authorized to mute this alert", ephemeral: true })
    return
  }

  const fingerprint = interaction.customId.slice(BUTTON_PREFIX.length)
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    await interaction.reply({ content: "invalid alert fingerprint", ephemeral: true })
    return
  }

  const now = new Date().toISOString()
  const result = getDb().prepare(
    `update owner_api_alerts set muted_at = ?, muted_by = ? where fingerprint = ?`,
  ).run(now, interaction.user.id, fingerprint)

  if (Number(result.changes ?? 0) === 0) {
    await interaction.reply({ content: "this alert no longer exists", ephemeral: true })
    return
  }

  const mutedButton = new ButtonBuilder()
    .setCustomId(interaction.customId)
    .setLabel("Muted forever")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true)
  await interaction.update({
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(mutedButton)],
  })
}
