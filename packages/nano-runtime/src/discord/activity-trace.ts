/**
 * Live activity trace buffer for slash command inspection.
 *
 * Subscribes to the stream and keeps a rolling window of recent events
 * so /trace can show what the agent is currently doing.
 */

import { subscribe } from "../stream"
import type { StreamEvent } from "@nano/protocol"

export interface TraceEntry {
  timestamp: number
  type: "text" | "thinking" | "tool" | "usage" | "user"
  // For text/thinking
  text?: string
  // For tool
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  // For usage
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    tokensPerSecond?: number
    cachedPromptTokens?: number
  }
  // For user
  source?: string
}

const MAX_ENTRIES = 100
const buffer: TraceEntry[] = []

let started = false

export function startActivityTrace(): void {
  if (started) return
  started = true

  subscribe((event: StreamEvent) => {
    const entry = convertEvent(event)
    if (!entry) return

    buffer.push(entry)
    if (buffer.length > MAX_ENTRIES) {
      buffer.splice(0, buffer.length - MAX_ENTRIES)
    }
  })
}

function convertEvent(event: StreamEvent): TraceEntry | null {
  const timestamp = Date.now()

  switch (event.type) {
    case "text":
      return { timestamp, type: "text", text: event.text }

    case "thinking":
      return { timestamp, type: "thinking", text: event.text }

    case "tool":
      return {
        timestamp,
        type: "tool",
        toolName: event.name,
        toolArgs: event.args,
        toolResult: event.result,
      }

    case "usage":
      return {
        timestamp,
        type: "usage",
        usage: {
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
          totalTokens: event.totalTokens,
          tokensPerSecond: event.tokensPerSecond,
          cachedPromptTokens: event.cachedPromptTokens,
        },
      }

    case "user":
      return { timestamp, type: "user", source: event.source, text: event.text }

    default:
      return null
  }
}

export function getRecentActivity(count = 15): TraceEntry[] {
  return buffer.slice(-count)
}

export function formatActivityTrace(entries: TraceEntry[]): string {
  if (entries.length === 0) {
    return "no recent activity"
  }

  const lines: string[] = []
  for (const entry of entries) {
    const time = new Date(entry.timestamp).toLocaleTimeString("en-US", { hour12: false })

    switch (entry.type) {
      case "user":
        lines.push(`[${time}] **input** (${entry.source})`)
        break
      case "text": {
        const text = entry.text ?? ""
        lines.push(`[${time}] **text:** ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`)
        break
      }
      case "thinking": {
        const text = entry.text ?? ""
        lines.push(`[${time}] **thinking:** ${text.slice(0, 150)}${text.length > 150 ? "..." : ""}`)
        break
      }
      case "tool": {
        const args = entry.toolArgs ?? {}
        const argStr = Object.keys(args).length > 0
          ? " " + Object.entries(args)
              .filter(([k]) => !k.startsWith("_"))
              .slice(0, 3)
              .map(([k, v]) => `${k}=${truncate(String(v), 40)}`)
              .join(" ")
          : ""
        const result = entry.toolResult ?? ""
        const resultStr = result.slice(0, 80)
        lines.push(`[${time}] **tool:** ${entry.toolName}${argStr} → ${resultStr}${result.length > 80 ? "..." : ""}`)
        break
      }
      case "usage": {
        const u = entry.usage ?? {}
        const parts: string[] = []
        if (u.promptTokens) parts.push(`in=${u.promptTokens}`)
        if (u.completionTokens) parts.push(`out=${u.completionTokens}`)
        if (u.cachedPromptTokens) parts.push(`cached=${u.cachedPromptTokens}`)
        if (u.tokensPerSecond) parts.push(`${u.tokensPerSecond.toFixed(1)} tok/s`)
        lines.push(`[${time}] **usage:** ${parts.join(" ")}`)
        break
      }
    }
  }

  return lines.join("\n")
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s
}
