import { executeToolCall, pushToolMessage } from "./loop-tool-runtime"
import type { FunctionToolCall, LoopHooks, LoopState } from "@nano/runtime-api/contracts/runner"

export type ToolCallsOutcome = "continue" | "rest" | "wait"
const MODEL_SWAP_ALLOWED_TOOLS: Record<string, true> = {
  memory_fs: true,
  edit_file: true,
  read_file: true,
  end_session: true,
  wait: true,
  wait_then_continue: true,
}

function skipRemainingToolCalls(
  convId: number,
  state: LoopState,
  calls: readonly FunctionToolCall[],
  startIndex: number,
  source: string,
): void {
  calls.slice(startIndex).forEach((pendingCall) => {
    const skippedContent = `skipped: interrupted by incoming ${source} event.`
    const result = pushToolMessage(convId, state, pendingCall, skippedContent)
    state.services?.events?.emit({ type: "tool", name: pendingCall.name, args: { _skipped: true }, result })
  })
}

function maybeInterruptAfterTool(
  convId: number,
  state: LoopState,
  hooks: LoopHooks,
  calls: readonly FunctionToolCall[],
  nextIndex: number,
): boolean {
  if (state.modelSwap) return false
  if (state.pendingInputs.length === 0) return false

  const incoming = state.pendingInputs.shift()!
  state.services?.discord?.clearTypingScope(state)
  hooks.injectIncomingEvent(convId, incoming)
  skipRemainingToolCalls(convId, state, calls, nextIndex, incoming.source)
  return true
}

/**
 * Processes all function tool calls requested in one assistant turn.
 *
 * @returns Whether the runner should continue, rest, or enter its idle wait.
 */
export async function processToolCalls(
  convId: number,
  state: LoopState,
  hooks: LoopHooks,
  calls: readonly FunctionToolCall[],
): Promise<ToolCallsOutcome> {
  let shouldWaitForEvent = false
  for (let i = 0; i < calls.length; i++) {
    if (state.interruptRequested || state.discardRequested || state.operationSignal?.aborted) {
      skipRemainingToolCalls(convId, state, calls, i, "operator interrupt")
      return "continue"
    }
    const call = calls[i]!
    if (state.modelSwap && !MODEL_SWAP_ALLOWED_TOOLS[call.name]) {
      const skippedContent = "skipped: model swap handoff permits only journaling and end_session tools."
      const result = pushToolMessage(convId, state, call, skippedContent)
      state.services?.events?.emit({ type: "tool", name: call.name, args: { _skipped: true }, result })
      continue
    }
    const outcome = await executeToolCall(convId, state, hooks, call)
    if (state.interruptRequested || state.discardRequested || state.operationSignal?.aborted) {
      skipRemainingToolCalls(convId, state, calls, i + 1, "operator interrupt")
      return "continue"
    }
    if (outcome.shouldRest) return "rest"
    if (outcome.shouldWaitForEvent) {
      shouldWaitForEvent = true
      continue
    }
    if (outcome.isWait) continue
    if (state.interruptRequested || state.discardRequested || state.operationSignal?.aborted) {
      skipRemainingToolCalls(convId, state, calls, i + 1, "operator interrupt")
      return "continue"
    }
    if (maybeInterruptAfterTool(convId, state, hooks, calls, i + 1)) return "continue"
  }
  return shouldWaitForEvent ? "wait" : "continue"
}
