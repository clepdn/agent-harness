import type Database from "better-sqlite3"
import type { DiscordMessageTarget, UserMessage } from "../types"
import type { RuntimeKind } from "./runner"

export type DiscordRuntimeKind = "main" | "frontend"
export type DiscordPresence = "awake" | "resting"
export type DiscordObject = Record<string, unknown>

export type DiscordImageAttachment = {
  url: string
  filename: string | null
  contentType: string | null
  description?: string | null
}

export type DiscordFileAttachment = DiscordImageAttachment & {
  size: number | null
}

export type DiscordMessageRecord = {
  messageId: string
  channelId: string
  guildId: string | null
  channelType: number | null
  authorId: string | null
  authorUsername: string | null
  content: string
  createdAt: string
  isDm: boolean
  isFromBot: boolean
  isFromSelf: boolean
  mentionsBot: boolean
  rawJson: string
}

export type DiscordChannelRecord = {
  channelId: string
  guildId: string | null
  channelType: number | null
  channelName: string | null
  guildName: string | null
  topic: string | null
  isDm: boolean
  configured: boolean
  rawJson: string
}

export interface DiscordTriggerOptions {
  readonly db?: Database.Database
  readonly modelVision?: boolean
  readonly pronouns?: (userId: string) => string | null
  readonly friendlyId?: (messageId: string, channelId: string) => string
}

export type DiscordIngestResult = {
  stored: boolean
  isNew: boolean
  messageId?: string
  channelId?: string
  itemId?: string
  bucket?: "dm" | "mention"
  isFromBot?: boolean
  isFromSelf?: boolean
  authorId?: string | null
  isDm?: boolean
  configured?: boolean
  guildId?: string | null
  reason?: string
}

export type DiscordBatchDigest = {
  content: string
  targets: DiscordMessageTarget[]
  messageCount: number
  pendingCount: number
  from: string
  to: string
}

export type DiscordIngressOutcome = {
  ingested: boolean
  woke: boolean
  reason: "ingest_only" | "wake_on_event" | "dm_priority" | "cooldown" | string
  note?: string
}

export type DiscordWakeRuntime = (
  event: UserMessage,
  runtimeKind: RuntimeKind,
  options?: { priority?: boolean },
) => void | Promise<void>

export interface DiscordPipelineOptions {
  readonly trigger?: DiscordTriggerOptions
  readonly runtimeFor?: (ingest: DiscordIngestResult) => RuntimeKind
  readonly isChannelActive?: (channelId: string) => boolean
}

export type DiscordTargetRegistration = {
  targets: DiscordMessageTarget[]
  incomingTargets: DiscordMessageTarget[]
}

export type DiscordEmbeddings = {
  configured(): boolean
  dimensions: number
  model: string
  embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]>
}

export type DiscordEmbeddingSyncResult = {
  embedded: number
  selected: number
  skipped?: string
}

export type DiscordEmbeddingBackfillHandle = { stop: () => void }

export type DiscordFriendlyIdRoute = {
  friendlyId: string
  messageId: string
  channelId: string
}

export type DiscordReplyContext = {
  message_id: string
  author_id: string | null
  author_username: string | null
  content: string
}

export type InboxStatus = "pending" | "seen" | "acted" | "ignored"
export type InboxAction = "none" | "replied" | "messaged" | "dismissed" | "noted"

export type DiscordDebounce = {
  debounceDmWake<T>(channelId: string, userId: string, item: T, fire: (items: readonly T[]) => void): boolean
  debounceChannelWake<T>(channelId: string, item: T, fire: (items: readonly T[]) => void): boolean
  noteDmTyping(channelId: string, userId?: string): void
  reset(): void
}

export type DiscordTypingController = {
  dispatch(turnId: string, channelId: string): void
  stop(turnId: string): void
  notify(turnId: string): void
  beginToolWait(turnId: string): void
  endToolWait(turnId: string): void
  cleanup(scope?: string): void
  reset(): void
}

export type DiscordGatewayHandle = {
  stop: () => Promise<void>
  refreshCommands: () => Promise<void>
}
