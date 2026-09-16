import { config } from "../config"
import { enqueueEvent, isRunning, wake } from "../runner/index"
import { enqueueFrontendEvent, isFrontendRunning, wakeFrontend } from "../runner/frontend"
import { fromDiscord } from "../triggers/discord"
import type { UserMessage } from "../types"
import { isChannelActiveNow } from "./cooldown"
import { markDiscordMessagesDispatched } from "./db"
import { ingestDiscordEvent, type DiscordIngestResult } from "./state"

const DISCORD_WAKE_ON_EVENT = config.discord.wake_on_event

export type DiscordIngressOutcome = {
  ingested: boolean
  woke: boolean
  reason: "ingest_only" | "wake_on_event" | "dm_priority" | "cooldown"
  note?: string
}

export function discordRuntimeFor(ingest: DiscordIngestResult): "main" | "frontend" {
  const ownerDm = ingest.isDm === true && Boolean(config.discord.owner_id) && ingest.authorId === config.discord.owner_id
  return config.frontend.enable && !ownerDm ? "frontend" : "main"
}

export function handleDiscordIngress(
  payload: unknown,
  preparedIngest?: DiscordIngestResult,
  preparedEvent?: UserMessage,
): DiscordIngressOutcome {
  const ingest = preparedIngest ?? ingestDiscordEvent(payload)
  const wakeForDm = ingest.bucket === "dm"
  const wakeForChannel = !ingest.isDm && ingest.configured === true && DISCORD_WAKE_ON_EVENT
  const isWakeEligible = ingest.isNew && !ingest.isFromSelf && (wakeForDm || wakeForChannel)

  // Cooldown channels: keep ingesting for memory, but never wake outside the
  // configured active hours (even for @mentions; DMs bypass cooldowns).
  const outsideActiveHours = !wakeForDm && ingest.channelId != null && !isChannelActiveNow(ingest.channelId)
  if (isWakeEligible && outsideActiveHours) {
    return {
      ingested: ingest.stored,
      woke: false,
      reason: "cooldown",
      ...(ingest.reason ? { note: ingest.reason } : {}),
    }
  }

  const shouldWake = isWakeEligible && (wakeForDm || wakeForChannel)

  if (!shouldWake) {
    return {
      ingested: ingest.stored,
      woke: false,
      reason: "ingest_only",
      ...(ingest.reason ? { note: ingest.reason } : {}),
    }
  }

  const event = preparedEvent ?? fromDiscord(payload)
  const runtime = discordRuntimeFor(ingest)
  if (runtime === "frontend") {
    if (isFrontendRunning()) enqueueFrontendEvent(event, { priority: wakeForDm })
    else void wakeFrontend(event)
  } else if (isRunning()) enqueueEvent(event, { priority: wakeForDm })
  else void wake(event)

  if (ingest.messageId) markDiscordMessagesDispatched([ingest.messageId])

  return {
    ingested: ingest.stored,
    woke: true,
    reason: wakeForDm ? "dm_priority" : "wake_on_event",
    ...(ingest.reason ? { note: ingest.reason } : {}),
  }
}
