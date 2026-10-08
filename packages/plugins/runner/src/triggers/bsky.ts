import type { UserMessage } from "@nano/runtime-api/types"

export function fromBsky(body: unknown): UserMessage {
  const b = body as Record<string, unknown>
  return {
    source: "bsky",
    triggeredAt: new Date().toISOString(),
    content: String(b.text ?? b.content ?? ""),
    raw: body,
  }
}
