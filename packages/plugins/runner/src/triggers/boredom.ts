import type { UserMessage } from "@nano/runtime-api/types"

export function fromBoredom(): UserMessage {
  return {
    source: "boredom",
    triggeredAt: new Date().toISOString(),
    content:
      "[boredom] no events for a while. check your inbox, feeds, or anything pending. reach out to someone you care about if it feels right. if there's truly nothing to do, rest.",
    raw: null,
  }
}
