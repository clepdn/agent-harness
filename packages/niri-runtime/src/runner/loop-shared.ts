import type { AssistantMessage, ToolCall, Usage } from "../llm"
import type { LoopHooks, LoopState } from "./types"

/** A tool call from the assistant (pi's native ToolCall type). */
export type FunctionToolCall = ToolCall

/** Tool argument map — pi args are already parsed objects. */
export type ToolArgs = Record<string, unknown>

export type ToolExecutionOutcome = { shouldRest?: boolean; isWait?: boolean }

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
