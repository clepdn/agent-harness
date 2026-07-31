import { config } from "../config"
import { enqueueEvent, isRunning, wake } from "../runner/index"
import { fromDiscord } from "../triggers/discord"
import { isChannelActiveNow } from "./cooldown"
import { debounceDmWake } from "./dm-debounce"
import { ingestDiscordEvent } from "./state"

const DISCORD_WAKE_ON_EVENT = config.discord.wake_on_event

export type DiscordIngressOutcome = {
  ingested: boolean
  woke: boolean
  reason: "ingest_only" | "wake_on_event" | "dm_priority" | "cooldown"
  note?: string
}

export function handleDiscordIngress(payload: unknown): DiscordIngressOutcome {
  const ingest = ingestDiscordEvent(payload)
  const isWakeEligible = ingest.isNew && !ingest.isFromSelf && Boolean(ingest.bucket)
  const wakeForDm = ingest.bucket === "dm"

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

  const shouldWake = isWakeEligible && (DISCORD_WAKE_ON_EVENT || wakeForDm)

  if (!shouldWake) {
    return {
      ingested: ingest.stored,
      woke: false,
      reason: "ingest_only",
      ...(ingest.reason ? { note: ingest.reason } : {}),
    }
  }

  const event = fromDiscord(payload)

  const deliver = () => {
    if (isRunning()) {
      enqueueEvent(event, { priority: wakeForDm })
    } else {
      void wake(event)
    }
  }

  // DM wakes are debounced: hold briefly so an incoming typing indicator or a
  // rapid follow-up message can extend the window, then wake once. If the
  // runner is already running we skip the debounce — the event is enqueued
  // immediately since there's no cold-start activation to coalesce.
  if (wakeForDm && ingest.channelId && !isRunning()) {
    const deferred = debounceDmWake(ingest.channelId, deliver)
    return {
      ingested: ingest.stored,
      woke: !deferred,
      reason: "dm_priority",
      ...(deferred ? { note: "debounced" } : ingest.reason ? { note: ingest.reason } : {}),
    }
  }

  deliver()

  return {
    ingested: ingest.stored,
    woke: true,
    reason: wakeForDm ? "dm_priority" : "wake_on_event",
    ...(ingest.reason ? { note: ingest.reason } : {}),
  }
}
