import type Database from "better-sqlite3"
import type { Usage } from "../llm"
import type { MemorySearchResult } from "./memory"

export interface BaseMetricEvent {
  timestamp: string
}

export interface PromptResponseMetric extends BaseMetricEvent {
  type: "prompt_response"
  model: string
  toolChoice?: string
  messageCount?: number
  lastUserMessage?: string
  responsePreview?: string
  toolCallCount?: number
  usage?: Usage
}

export interface MemoryMetric extends BaseMetricEvent {
  type: "memory"
  query: string
  results: MemorySearchResult[]
}

export interface CompactionMetric extends BaseMetricEvent {
  type: "compaction"
  before: number
  after: number
  method: string
  summary?: string
}

export interface UsageMetric extends BaseMetricEvent {
  type: "usage"
  usage: Usage
}

export type MetricEvent = PromptResponseMetric | MemoryMetric | CompactionMetric | UsageMetric
export type MetricListType = "response" | "summarization" | "memory" | "usage" | "discord"
export type MetricBucketName = "memories" | "summarization" | "response" | "usage" | "discord"

export interface BaseMetricListItem extends BaseMetricEvent {
  id: number
  sourceType: MetricEvent["type"]
  detailPath: string
}

export type MetricListItem =
  | (BaseMetricListItem & {
      type: "response"
      promptMetricId?: number
      model?: string
      toolChoice?: string
      messageCount?: number
      lastUserMessage?: string
      responsePreview?: string
      toolCallCount?: number
      usage?: Usage
    })
  | (BaseMetricListItem & {
      type: "summarization"
      method?: string
      before?: number
      after?: number
      savedTokens?: number
      summaryPreview?: string
      summaryChars?: number
    })
  | (BaseMetricListItem & {
      type: "memory"
      queryPreview?: string
      resultCount?: number
    })
  | (BaseMetricListItem & {
      type: "usage"
      usage?: Usage
    })

export interface MetricsQuery {
  limit?: number
  cursor?: number
  cursors?: Partial<Record<MetricBucketName, string | number>>
  type?: MetricListType[]
  includeRaw?: boolean
  q?: string
  from?: string
  to?: string
}

export interface DiscordMetricListItem extends BaseMetricEvent {
  id: string
  type: "discord"
  sourceType: "discord"
  detailPath: string
  messageId: string
  channelId: string
  guildId?: string
  authorId?: string
  authorUsername?: string
  contentPreview?: string
  isDm: boolean
  mentionsBot: boolean
  isFromBot: boolean
}

export interface MetricsPage {
  memories: MetricListItem[]
  summarization: MetricListItem[]
  response: MetricListItem[]
  usage: MetricListItem[]
  discord: DiscordMetricListItem[]
  limit: number
  nextCursor: Partial<Record<MetricBucketName, string | number>>
  hasMore: Partial<Record<MetricBucketName, boolean>>
  filters: {
    type?: MetricListType[]
    includeRaw: boolean
    q?: string
    from?: string
    to?: string
  }
}

export type MetricEventInput =
  | Omit<PromptResponseMetric, "timestamp">
  | Omit<MemoryMetric, "timestamp">
  | Omit<CompactionMetric, "timestamp">
  | Omit<UsageMetric, "timestamp">

export interface MetricsStore {
  recordMetric(event: MetricEventInput): number | null
  getMetrics(query?: MetricsQuery): MetricsPage
  getMetricDetail(id: number): (MetricEvent & { id: number }) | null
  getDiscordMetricDetail(id: string): (DiscordMetricListItem & { raw: unknown }) | null
  close(): void
}

export interface MetricsStoreOptions {
  readonly path?: string
  readonly nanoDb?: Database.Database
  readonly retentionDays?: number
  readonly home?: string
}

export interface PrometheusScrapeSource {
  render(): string
}
