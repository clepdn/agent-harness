import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type MessageCreateOptions,
} from "discord.js"
import type Database from "better-sqlite3"
import { config, redactSecrets } from "../config"
import type { ClassifiedApiError } from "../api-errors"

const BUTTON_PREFIX = "owner-api-alert:mute:"
const REPEAT_NOTIFICATION_MS = 6 * 60 * 60 * 1000
const TRANSIENT_NOTIFICATION_THRESHOLD = 3

export type OwnerAlertSender = (payload: MessageCreateOptions) => Promise<void>

type AlertRow = {
  occurrence_count: number
  last_notified_at: string | null
  muted_at: string | null
}
export interface OwnerAlertButtonInteraction {
  readonly customId: string
  readonly user: { readonly id: string }
  reply(options: InteractionReplyOptions): Promise<unknown>
  update(options: InteractionUpdateOptions): Promise<unknown>
}

export interface DiscordOwnerAlerts {
  setSender(next: OwnerAlertSender | null): void
  reportApiError(db: Database.Database, error: ClassifiedApiError): Promise<void>
  isButton(interaction: OwnerAlertButtonInteraction): boolean
  handleButton(db: Database.Database, interaction: OwnerAlertButtonInteraction): Promise<void>
  stop(): void
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

async function recordAndNotify(db: Database.Database, error: ClassifiedApiError, sender: OwnerAlertSender | null): Promise<void> {
  try {
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

    if (!sender || !shouldNotify(error, row, now.getTime())) return

    await sender(alertPayload(error, row.occurrence_count))
    db.prepare(
      "update owner_api_alerts set last_notified_at = ? where fingerprint = ?",
    ).run(nowIso, error.fingerprint)
  } catch (err) {
    console.warn("[owner alert] failed:", err instanceof Error ? err.message : String(err))
  }
}

export function createOwnerAlerts(options: { ownerId?: () => string } = {}): DiscordOwnerAlerts {
  let sender: OwnerAlertSender | null = null
  let queue = Promise.resolve()
  let stopped = false
  const ownerId = options.ownerId ?? (() => config.discord.owner_id)

  const setSender = (next: OwnerAlertSender | null): void => {
    if (!stopped) sender = next
  }

  const reportApiError = (db: Database.Database, error: ClassifiedApiError): Promise<void> => {
    if (stopped) return Promise.resolve()
    const pending = queue.then(() => recordAndNotify(db, error, sender))
    queue = pending.catch(() => {})
    return pending
  }

  const isButton = (interaction: OwnerAlertButtonInteraction): boolean => interaction.customId.startsWith(BUTTON_PREFIX)

  const handleButton = async (db: Database.Database, interaction: OwnerAlertButtonInteraction): Promise<void> => {
    if (interaction.user.id !== ownerId()) {
      await interaction.reply({ content: "you are not authorized to mute this alert", ephemeral: true })
      return
    }

    const fingerprint = interaction.customId.slice(BUTTON_PREFIX.length)
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
      await interaction.reply({ content: "invalid alert fingerprint", ephemeral: true })
      return
    }

    const now = new Date().toISOString()
    const result = db.prepare(
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

  return {
    setSender,
    reportApiError,
    isButton,
    handleButton,
    stop: () => { stopped = true; sender = null; queue = Promise.resolve() },
  }
}
