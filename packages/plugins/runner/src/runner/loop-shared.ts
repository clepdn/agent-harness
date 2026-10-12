import type { AssistantMessage, Usage } from "@nano/runtime-api/llm"
import type { FunctionToolCall, LoopHooks, LoopState } from "@nano/runtime-api/contracts/runner"
import type { StreamEvent, StreamIdentity } from "@nano/protocol"

/** Live lane identity derived from the loop state, or undefined before a conversation is bound. */
export function liveIdentity(state: LoopState): StreamIdentity | undefined {
  const conversationId = state.activeConversationId
  if (conversationId === undefined) return undefined
  return {
    runtimeKind: state.runtimeKind ?? "main",
    conversationId,
    step: state.stepIndex ?? 0,
    attempt: state.attemptIndex ?? 0,
  }
}

/** Binds live identity to a conversation; step and attempt restart only when the conversation changes. */
export function bindConversation(state: LoopState, conversationId: number): void {
  if (state.activeConversationId === conversationId) return
  state.activeConversationId = conversationId
  state.stepIndex = 0
  state.attemptIndex = 0
}

/**
 * Emits a live stream frame, stamping the loop state's identity onto data
 * frames. Lifecycle frames that already carry an explicit identity keep it.
 */
export function emitStream(state: LoopState, event: StreamEvent): void {
  const events = state.services?.events
  if (!events) return
  if ("identity" in event && event.identity) {
    events.emit(event)
    return
  }
  const identity = liveIdentity(state)
  if (!identity) {
    events.emit(event)
    return
  }
  // Spreading a discriminated union erases the discriminant narrowing; the
  // added identity field is valid on every data variant.
  events.emit({ ...event, identity } as StreamEvent)
}


/** Tool argument map — pi args are already parsed objects. */
export type ToolArgs = Record<string, unknown>

export type ToolExecutionOutcome = {
  shouldRest?: boolean
  /** Return control to the runner's idle wait, which also owns idle compaction. */
  shouldWaitForEvent?: boolean
  /** The tool performed its own bounded wait and received an event. */
  isWait?: boolean
}

export type CompletionTurnResult = {
  message: AssistantMessage
  usage: Usage
  emittedText: boolean
  emittedThinking: boolean
  bufferedThinking: string
  /** Runner-measured completion stream duration in milliseconds. */
  elapsedMs?: number
  /** Runner-computed completion throughput in tokens per second. */
  tokensPerSecond?: number
}

export type ToolArgKey = string
export type ArgTuple<K extends readonly string[]> = { [I in keyof K]: unknown }

export type ToolExecutionContext = {
  convId: number
  state: LoopState
  hooks: LoopHooks
  call: FunctionToolCall
  args: ToolArgs
}

export type ToolHandler = (ctx: ToolExecutionContext) => Promise<ToolExecutionOutcome>
