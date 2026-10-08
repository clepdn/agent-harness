import type { RuntimeExecutionServices } from "@nano/runtime-api"
import type { RuntimeKind, LoopState, ManualCompactionRequest } from "@nano/runtime-api/contracts/runner"
import type { DiscordMessageTarget, RunnerState, UserMessage } from "@nano/runtime-api/types"
import type { ToolDefinition } from "@nano/harness-core"

export interface RunnerStateInternal extends RunnerState {
  runtimeKind: RuntimeKind
  services?: RuntimeExecutionServices
  toolCatalog: ToolDefinition[]
  toolCatalogEpoch: number
  toolCatalogFingerprint: string
  toolInFlight: boolean
  shutdownRequested: boolean
  turnInFlight: boolean
  activeTurnController?: AbortController
  operationSignal?: AbortSignal
  compactionInFlight?: boolean
  interruptRequested?: boolean
  discardRequested?: boolean
  deferredEvents: Array<{ event: UserMessage; priority: boolean }>
  restRequested: boolean
  restReason: string
  modelSwap?: LoopState["modelSwap"]
  compactionRequest?: ManualCompactionRequest
  discordTypingTurnId?: string
  discordTypingChannelId?: string
  discordTargets?: DiscordMessageTarget[]
}
