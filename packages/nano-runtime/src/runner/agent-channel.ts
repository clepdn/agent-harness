import { randomUUID } from "node:crypto"
import type Database from "better-sqlite3"
import type { UserMessage } from "../types"
import type { RuntimeKind } from "./types"

export interface AgentChannelRow {
  id: string
  sender: RuntimeKind
  recipient: RuntimeKind
  content: string
  created_at: string
  delivered_at: string | null
}

export interface AgentChannelService {
  sendAgentChannelMessage(sender: RuntimeKind, content: unknown): Promise<Record<string, unknown>>
  listAgentChannelMessages(params?: { limit?: unknown; beforeId?: unknown }): Record<string, unknown>
}

export type AgentChannelDelivery = (recipient: RuntimeKind, event: UserMessage) => Promise<boolean> | boolean

export interface AgentMailbox extends AgentChannelService {
  runtimeReady(kind: RuntimeKind): Promise<void>
}

function otherAgent(sender: RuntimeKind): RuntimeKind {
  return sender === "frontend" ? "main" : "frontend"
}

function eventFor(row: AgentChannelRow): UserMessage {
  return {
    source: "agent",
    triggeredAt: row.created_at,
    content: [`[agent channel] from ${row.sender}`, "", row.content].join("\n"),
    raw: { type: "agent_channel", id: row.id, sender: row.sender, recipient: row.recipient },
  }
}

/** Create a durable mailbox over the application's persistence service. */
export function createAgentChannelService(db: Database.Database, deliver?: AgentChannelDelivery): AgentMailbox {
  const ready = new Set<RuntimeKind>()
  const delivering = new Set<string>()

  function markDelivered(id: string): void {
    db.prepare("update agent_channel_messages set delivered_at = coalesce(delivered_at, ?) where id = ?")
      .run(new Date().toISOString(), id)
  }

  async function tryDeliver(row: AgentChannelRow): Promise<boolean> {
    if (!ready.has(row.recipient) || delivering.has(row.id) || !deliver) return false
    delivering.add(row.id)
    try {
      if (!await deliver(row.recipient, eventFor(row))) return false
      markDelivered(row.id)
      return true
    } finally {
      delivering.delete(row.id)
    }
  }

  async function runtimeReady(recipient: RuntimeKind): Promise<void> {
    ready.add(recipient)
    const pending = db.prepare(
      `select id, sender, recipient, content, created_at, delivered_at
       from agent_channel_messages
       where recipient = ? and delivered_at is null
       order by created_at asc, id asc`,
    ).all(recipient) as AgentChannelRow[]
    for (const row of pending) {
      try {
        await tryDeliver(row)
      } catch (error) {
        console.error(`[agent-channel] replay failed for ${row.id}:`, error)
      }
    }
  }

  return {
    runtimeReady,
    async sendAgentChannelMessage(sender, content) {
      if (typeof content !== "string" || !content.trim()) throw new Error("content is required")
      const cleanContent = content.trim()
      if (Buffer.byteLength(cleanContent, "utf8") > 64_000) throw new Error("agent channel content exceeds 64000 bytes")
      const row: AgentChannelRow = {
        id: `agent_${randomUUID()}`,
        sender,
        recipient: otherAgent(sender),
        content: cleanContent,
        created_at: new Date().toISOString(),
        delivered_at: null,
      }
      db.prepare(
        `insert into agent_channel_messages
           (id, sender, recipient, content, created_at, delivered_at)
         values (@id, @sender, @recipient, @content, @created_at, null)`,
      ).run(row)
      const delivered = await tryDeliver(row)
      return {
        ok: true,
        id: row.id,
        sender: row.sender,
        recipient: row.recipient,
        created_at: row.created_at,
        delivered,
      }
    },
    listAgentChannelMessages(params = {}) {
      const limit = Math.max(1, Math.min(100, Math.trunc(Number(params.limit)) || 20))
      const beforeId = typeof params.beforeId === "string" ? params.beforeId.trim() : ""
      let beforeCreatedAt = ""
      if (beforeId) {
        const row = db.prepare("select created_at from agent_channel_messages where id = ?").get(beforeId) as
          | { created_at: string }
          | undefined
        if (!row) throw new Error(`unknown agent channel before_id: ${beforeId}`)
        beforeCreatedAt = row.created_at
      }
      const rows = db.prepare(
        `select id, sender, recipient, content, created_at, delivered_at
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
          created_at: row.created_at,
          delivered: row.delivered_at !== null,
        })),
      }
    },
  }
}
