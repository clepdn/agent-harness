import type { ToolResultMessage } from "@earendil-works/pi-ai"
import { redactSecrets } from "../config"
import { logMessage } from "../db"
import { emit } from "../stream"
import { latestAssistantContent } from "./loop-content"
import type {
  ArgTuple,
  FunctionToolCall,
  ToolArgKey,
  ToolArgs,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolHandler,
} from "./loop-shared"
import type { LoopHooks, LoopState } from "./types"
import { errorSummary } from "./messages"

type StandardToolSpec<
  RunKeys extends readonly ToolArgKey[],
  LogKeys extends readonly ToolArgKey[] = RunKeys,
  EmitKeys extends readonly ToolArgKey[] | undefined = undefined,
> = {
  name: string
  logArgKeys: LogKeys
  runArgKeys: RunKeys
  run: (...values: ArgTuple<RunKeys>) => Promise<string>
  emptyFallback?: string
  emitArgKeys?: EmitKeys
  previewChars?: number
}

/**
 * Appends a tool-role message to conversation state and persistence logs.
 * Tool output is filtered through `redactSecrets` first so credentials that
 * leak via command output (curl -v, env, sloppy logging) never reach the
 * model, the db, or stream subscribers.
 */
export function pushToolMessage(convId: number, state: LoopState, call: FunctionToolCall, content: string): string {
  const safe = redactSecrets(content)
  const toolMsg: ToolResultMessage = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: safe }],
    isError: safe.startsWith("error:"),
    timestamp: Date.now(),
  }
  state.conversation.push(toolMsg)
  logMessage(convId, "toolResult", safe, undefined, call.id)
  return safe
}

function hasToolResponse(state: LoopState, call: FunctionToolCall): boolean {
  return state.conversation.some(
    (message) => message.role === "toolResult" && message.toolCallId === call.id,
  )
}

/**
 * Records a tool result and emits it to stream subscribers.
 */
export function recordToolResult(
  convId: number,
  state: LoopState,
  call: FunctionToolCall,
  name: string,
  args: Record<string, unknown>,
  content: string,
): string {
  const result = pushToolMessage(convId, state, call, content)
  emit({ type: "tool", name, args, result })
  return result
}

/**
 * Normalizes thrown values into tool-friendly error text.
 */
export function toolError(err: unknown): string {
  return `error: ${err instanceof Error ? err.message : String(err)}`
}

function argsByKeys<K extends readonly ToolArgKey[]>(args: ToolArgs, keys: K): ArgTuple<K> {
  return keys.map((key) => args[key]) as ArgTuple<K>
}

function pickArgsByKeys<K extends readonly ToolArgKey[]>(args: ToolArgs, keys: K): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, args[key]]))
}

/**
 * Executes a standard "run command then record result" tool pattern.
 */
export async function runStandardTool<
  RunKeys extends readonly ToolArgKey[],
  LogKeys extends readonly ToolArgKey[] = RunKeys,
  EmitKeys extends readonly ToolArgKey[] | undefined = undefined,
>(
  ctx: ToolExecutionContext,
  spec: StandardToolSpec<RunKeys, LogKeys, EmitKeys>,
): Promise<ToolExecutionOutcome> {
  console.log(`[${spec.name}]`, ...argsByKeys(ctx.args, spec.logArgKeys))
  const raw = await spec.run(...argsByKeys(ctx.args, spec.runArgKeys)).catch(toolError)
  const previewChars = spec.previewChars ?? 200
  const preview = previewChars === 0 ? raw : raw.slice(0, previewChars)
  console.log(`[${spec.name} result]`, preview)
  const content = raw || spec.emptyFallback || raw
  const emitArgs = spec.emitArgKeys ? pickArgsByKeys(ctx.args, spec.emitArgKeys) : ctx.args
  recordToolResult(ctx.convId, ctx.state, ctx.call, spec.name, emitArgs, content)
  return {}
}

/**
 * Executes one function tool call end-to-end.
 */
export async function executeToolCall(
  convId: number,
  state: LoopState,
  hooks: LoopHooks,
  handlers: Record<string, ToolHandler>,
  call: FunctionToolCall,
): Promise<ToolExecutionOutcome> {
  // Pi args are already a parsed object — no JSON parsing needed.
  const args: ToolArgs = call.arguments as ToolArgs

  if ((call.name === "wait" || call.name === "rest") && latestAssistantContent(state).length === 0) {
    console.warn(
      `[runner] ${call.name} called with empty assistant content; allowing tool-only turn (provider emitted no text).`,
    )
  }

  const isWaitTool = call.name === "wait" || call.name === "wait_then_continue"
  if (!isWaitTool) state.toolInFlight = true

  try {
    const handler = handlers[call.name]
    if (!handler) {
      const errorText = `error: unknown tool ${call.name}`
      recordToolResult(convId, state, call, call.name, { _unknown_tool: call.name }, errorText)
      return {}
    }
    return await handler({ convId, state, hooks, call, args })
  } catch (err) {
    const errorText = toolError(err)
    if (!hasToolResponse(state, call)) {
      recordToolResult(convId, state, call, call.name, { _handler_error: true }, errorText)
    } else {
      console.warn(`[runner] ${call.name} failed after recording tool response: ${errorText}`)
    }
    return {}
  } finally {
    if (!isWaitTool) {
      state.toolInFlight = false
      hooks.flushDeferredEvents()
    }
  }
}
