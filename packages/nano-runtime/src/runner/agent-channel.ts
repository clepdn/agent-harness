import { randomUUID } from "node:crypto"
import { getDb } from "../db"
import type { UserMessage } from "../types"
import type { RuntimeKind } from "./types"

type AgentChannelRow = {
  id: string
  sender: RuntimeKind
  recipient: RuntimeKind
  content: string
  reply_to: string | null
  created_at: string
  delivered_at: string | null
}

type AgentChannelDelivery = (recipient: RuntimeKind, event: UserMessage) => boolean

let deliver: AgentChannelDelivery | null = null

function otherAgent(sender: RuntimeKind): RuntimeKind {
  return sender === "frontend" ? "main" : "frontend"
}

function eventFor(row: AgentChannelRow): UserMessage {
  return {
    source: "agent",
    triggeredAt: row.created_at,
    content: [
      `[agent channel] from ${row.sender}`,
      `message_id: ${row.id}`,
      row.reply_to ? `reply_to: ${row.reply_to}` : null,
      "",
      row.content,
    ].filter((line): line is string => line !== null).join("\n"),
    raw: {
      type: "agent_channel",
      id: row.id,
      sender: row.sender,
      recipient: row.recipient,
      replyTo: row.reply_to,
    },
  }
}

function markDelivered(id: string): void {
  getDb().prepare(
    "update agent_channel_messages set delivered_at = coalesce(delivered_at, ?) where id = ?",
  ).run(new Date().toISOString(), id)
}

function tryDeliver(row: AgentChannelRow): boolean {
  if (!deliver || !deliver(row.recipient, eventFor(row))) return false
  markDelivered(row.id)
  return true
}

/** Install the in-process main/frontend dispatcher and replay pending mail. */
export function configureAgentChannelDelivery(callback: AgentChannelDelivery | null): void {
  deliver = callback
  if (!callback) return
  const pending = getDb().prepare(
    `select id, sender, recipient, content, reply_to, created_at, delivered_at
     from agent_channel_messages
     where delivered_at is null
     order by created_at asc, id asc`,
  ).all() as AgentChannelRow[]
  for (const row of pending) tryDeliver(row)
}

/** Persist a message before attempting to wake the other virtual agent. */
export function sendAgentChannelMessage(
  sender: RuntimeKind,
  content: unknown,
  replyTo?: unknown,
): Record<string, unknown> {
  if (typeof content !== "string" || !content.trim()) throw new Error("content is required")
  const cleanContent = content.trim()
  if (Buffer.byteLength(cleanContent, "utf8") > 64_000) {
    throw new Error("agent channel content exceeds 64000 bytes")
  }
  const cleanReplyTo = typeof replyTo === "string" && replyTo.trim() ? replyTo.trim() : null
  if (cleanReplyTo) {
    const exists = getDb().prepare("select 1 from agent_channel_messages where id = ?").get(cleanReplyTo)
    if (!exists) throw new Error(`unknown agent channel reply_to id: ${cleanReplyTo}`)
  }

  const row: AgentChannelRow = {
    id: `agent_${randomUUID()}`,
    sender,
    recipient: otherAgent(sender),
    content: cleanContent,
    reply_to: cleanReplyTo,
    created_at: new Date().toISOString(),
    delivered_at: null,
  }
  getDb().prepare(
    `insert into agent_channel_messages
       (id, sender, recipient, content, reply_to, created_at, delivered_at)
     values (@id, @sender, @recipient, @content, @reply_to, @created_at, null)`,
  ).run(row)
  const delivered = tryDeliver(row)
  return {
    ok: true,
    id: row.id,
    sender: row.sender,
    recipient: row.recipient,
    reply_to: row.reply_to,
    created_at: row.created_at,
    delivered,
  }
}

/** Read the shared durable mailbox in reverse chronological order. */
export function listAgentChannelMessages(params: {
  limit?: unknown
  beforeId?: unknown
} = {}): Record<string, unknown> {
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(params.limit)) || 20))
  const beforeId = typeof params.beforeId === "string" ? params.beforeId.trim() : ""
  let beforeCreatedAt = ""
  if (beforeId) {
    const row = getDb().prepare("select created_at from agent_channel_messages where id = ?").get(beforeId) as
      | { created_at: string }
      | undefined
    if (!row) throw new Error(`unknown agent channel before_id: ${beforeId}`)
    beforeCreatedAt = row.created_at
  }
  const rows = getDb().prepare(
    `select id, sender, recipient, content, reply_to, created_at, delivered_at
     from agent_channel_messages
     where (? = '' or created_at < ? or (created_at = ? and id < ?))
     order by created_at desc, id desc
     limit ?`,
  ).all(beforeCreatedAt, beforeCreatedAt, beforeCreatedAt, beforeId, limit) as AgentChannelRow[]
  return {
    messages: rows.map((row) => ({
      id: row.id,
      sender: row.sender,
      recipient: row.recipient,
      content: row.content,
      reply_to: row.reply_to,
      created_at: row.created_at,
      delivered: row.delivered_at !== null,
    })),
  }
}
