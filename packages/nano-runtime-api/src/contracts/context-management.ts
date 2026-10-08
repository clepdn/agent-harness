import type { Message } from "../llm"
import type { RuntimeKind } from "./runner"

export interface SummaryOptions {
  recentMinKeep?: number
  recentMaxKeep?: number
  tailCharBudget?: number
  maxTranscriptChars?: number
  agentContext?: string | null
  primaryHandoff?: boolean
  runtimeKind?: RuntimeKind
}

export interface SummaryContextDependencies {
  readonly home: string
  readonly readFrontendSoul: () => Promise<string>
}

export interface DeepArchiveResult {
  note: string
  archiveMessage?: Message
}

export interface DeepArchiveBackend {
  readonly name: string
  archive(discarded: Message[]): Promise<DeepArchiveResult | null>
}
