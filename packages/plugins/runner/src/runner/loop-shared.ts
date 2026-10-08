import type { AssistantMessage, Usage } from "@nano/runtime-api/llm"
import type { FunctionToolCall, LoopHooks, LoopState } from "@nano/runtime-api/contracts/runner"

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
