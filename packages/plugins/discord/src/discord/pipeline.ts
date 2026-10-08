import type Database from "better-sqlite3"
import { config } from "@nano/runtime-api/config"
import { fromDiscord } from "../triggers/discord"
import type { DiscordIngressOutcome, DiscordPipelineOptions, DiscordWakeRuntime, DiscordIngestResult } from "@nano/runtime-api/contracts/discord"
import type { UserMessage } from "@nano/runtime-api/types"
import { isChannelActiveNow } from "./cooldown"
import { markDiscordMessagesDispatched } from "./db"
import { ingestDiscordEvent } from "./state"
export type { DiscordIngressOutcome, DiscordPipelineOptions, DiscordWakeRuntime }

const DISCORD_WAKE_ON_EVENT = config.discord.wake_on_event

export function discordRuntimeFor(ingest: DiscordIngestResult): "main" | "frontend" {
  const ownerDm = ingest.isDm === true && Boolean(config.discord.owner_id) && ingest.authorId === config.discord.owner_id
  return config.frontend.enable && !ownerDm ? "frontend" : "main"
}

export function handleDiscordIngress(
  db: Database.Database,
  payload: unknown,
  wakeRuntime: DiscordWakeRuntime,
  preparedIngest?: DiscordIngestResult,
  preparedEvent?: UserMessage,
  options: DiscordPipelineOptions = {},
): DiscordIngressOutcome {
  const ingest = preparedIngest ?? ingestDiscordEvent(db, payload)
  const wakeForDm = ingest.bucket === "dm"
  const wakeForChannel = !ingest.isDm && ingest.configured === true && DISCORD_WAKE_ON_EVENT
  const isWakeEligible = ingest.isNew && !ingest.isFromSelf && (wakeForDm || wakeForChannel)

  // Cooldown channels: keep ingesting for memory, but never wake outside the
  // configured active hours (even for @mentions; DMs bypass cooldowns).
  const outsideActiveHours = !wakeForDm && ingest.channelId != null && !(options.isChannelActive ?? isChannelActiveNow)(ingest.channelId)
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

  const event = preparedEvent ?? fromDiscord(payload, options.trigger)
  const runtimeKind = (options.runtimeFor ?? discordRuntimeFor)(ingest)
  void wakeRuntime(event, runtimeKind, { priority: wakeForDm })

  if (ingest.messageId) markDiscordMessagesDispatched(db, [ingest.messageId])

  return {
    ingested: ingest.stored,
    woke: true,
    reason: wakeForDm ? "dm_priority" : "wake_on_event",
    ...(ingest.reason ? { note: ingest.reason } : {}),
  }
}
