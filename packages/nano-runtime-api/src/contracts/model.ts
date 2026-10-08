import type { Model } from "../llm"
import type { CompactionStrategy, ThinkingEffort, ToolChoice } from "../config"

export interface RuntimeModelConfig {
  primaryModel: Model | null
  primaryApiKey: string | undefined
  primaryToolChoice: ToolChoice
  primaryVision: boolean
  primaryNudgeOnNoTool: boolean
  idleCompactionMs: number
  cacheWarming: boolean
  cacheWarmingDurationMs: number
  cacheWarmingMode: "completion" | "prewarm"
  cacheLifetimeMs: number
  enableThinking: boolean
  thinkingEffort: ThinkingEffort
  fallbackModel: Model
  fallbackApiKey: string | undefined
  fallbackToolChoice: ToolChoice
  summaryModel: Model | null
  summaryApiKey: string | undefined
  respectPromptCache: boolean
  compactionStrategy: CompactionStrategy
  compactTriggerTokens: number
  deepArchive: boolean
  useFallback: boolean
}

export interface ModelSwapSelection {
  preset: string
  model: Model
  apiKey: string | undefined
  toolChoice: ToolChoice
  fast: boolean
  enableThinking: boolean
  thinkingEffort: ThinkingEffort
  vision: boolean
  nudgeOnNoTool: boolean
  idleCompactionMs: number
  cacheWarming: boolean
  cacheWarmingDurationMs: number
  cacheWarmingMode: "completion" | "prewarm"
  cacheLifetimeMs: number
  compactionStrategy: CompactionStrategy
  compactTriggerTokens: number
  deepArchive: boolean
  respectPromptCache: boolean
}
