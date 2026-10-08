import type { UserMessage } from "@nano/runtime-api/types"

export function fromCron(): UserMessage {
  return {
    source: "cron",
    triggeredAt: new Date().toISOString(),
    content: "Scheduled heartbeat.",
    raw: null,
  }
}
