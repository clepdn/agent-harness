import { emit } from "../stream"
import { clearDiscordTypingScope } from "../discord/typing-lease"
import { buildToolHandlers } from "./loop-tool-registry"
import { executeToolCall, pushToolMessage } from "./loop-tool-runtime"
import type { FunctionToolCall } from "./loop-shared"
import type { LoopHooks, LoopState } from "./types"

export type ToolCallsOutcome = "continue" | "rest" | "wait"

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
    emit({ type: "tool", name: pendingCall.name, args: { _skipped: true }, result })
  })
}

function maybeInterruptAfterTool(
  convId: number,
  state: LoopState,
  hooks: LoopHooks,
  calls: readonly FunctionToolCall[],
  nextIndex: number,
): boolean {
  if (state.pendingInputs.length === 0) return false

  const incoming = state.pendingInputs.shift()!
  clearDiscordTypingScope(state)
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
  const handlers = buildToolHandlers()
  let shouldWaitForEvent = false

  for (let i = 0; i < calls.length; i++) {
    if (state.interruptRequested || state.discardRequested || state.operationSignal?.aborted) {
      skipRemainingToolCalls(convId, state, calls, i, "operator interrupt")
      return "continue"
    }
    const call = calls[i]!
    const outcome = await executeToolCall(convId, state, hooks, handlers, call)

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

    const interrupted = maybeInterruptAfterTool(convId, state, hooks, calls, i + 1)
    if (interrupted) return "continue"
  }

  return shouldWaitForEvent ? "wait" : "continue"
}
export const __loopToolsTest = {
  maybeInterruptAfterTool,
}
