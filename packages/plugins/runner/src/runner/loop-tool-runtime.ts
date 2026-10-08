import type { ToolResultMessage } from "@nano/runtime-api/llm"
import { redactSecrets } from "@nano/runtime-api/config"
import { latestAssistantContent } from "./loop-content"
import { toolContextImageReferences } from "@nano/plugin-images/tool-context-images"
import type {
  ArgTuple,
  ToolArgKey,
  ToolArgs,
  ToolExecutionContext,
  ToolExecutionOutcome,
} from "./loop-shared"
import type { FunctionToolCall, LoopHooks, LoopState } from "@nano/runtime-api/contracts/runner"
const NEVER_ABORTED = new AbortController().signal

function hasToolResponse(state: LoopState, call: FunctionToolCall): boolean {
  return state.context.items.some((message) => message.role === "toolResult" && message.toolCallId === call.id)
}

const FRONTEND_HARD_DENY = new Set([
  "shell",
  "job_list",
  "job_status",
  "job_stdout",
  "job_cancel",
  "computer",
  "subagent",
  "skill",
  "discord_upload",
])

type StandardToolSpec<
  RunKeys extends readonly ToolArgKey[],
  LogKeys extends readonly ToolArgKey[] = RunKeys,
  EmitKeys extends readonly ToolArgKey[] | undefined = undefined,
> = {
  name: string
  logArgKeys: LogKeys
  runArgKeys: RunKeys
  run: (...values: ArgTuple<RunKeys>) => Promise<unknown> | unknown
  emptyFallback?: string
  emitArgKeys?: EmitKeys
  previewChars?: number
}

/** Appends a tool-role message to conversation state and scoped persistence. */
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
  state.context.append(toolMsg)
  state.services?.persistence?.logMessage(convId, "toolResult", safe, undefined, call.id)
  return safe
}

/** Records a tool result and emits it through the scoped event service. */
export function recordToolResult(
  convId: number,
  state: LoopState,
  call: FunctionToolCall,
  name: string,
  args: Record<string, unknown>,
  content: string,
): string {
  const result = pushToolMessage(convId, state, call, content)
  state.services?.events?.emit({ type: "tool", name, args, result } as never)
  return result
}

/** Normalizes thrown values into tool-friendly error text. */
export function toolError(err: unknown): string {
  return `error: ${err instanceof Error ? err.message : String(err)}`
}

function argsByKeys<K extends readonly ToolArgKey[]>(args: ToolArgs, keys: K): ArgTuple<K> {
  return keys.map((key) => args[key]) as ArgTuple<K>
}

function pickArgsByKeys<K extends readonly ToolArgKey[]>(args: ToolArgs, keys: K): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, args[key]]))
}

/** Executes a standard "run command then record result" tool pattern. */
export async function runStandardTool<
  RunKeys extends readonly ToolArgKey[],
  LogKeys extends readonly ToolArgKey[] = RunKeys,
  EmitKeys extends readonly ToolArgKey[] | undefined = undefined,
>(
  ctx: ToolExecutionContext,
  spec: StandardToolSpec<RunKeys, LogKeys, EmitKeys>,
): Promise<ToolExecutionOutcome> {
  console.log(`[${spec.name}]`, ...argsByKeys(ctx.args, spec.logArgKeys))
  const value = await Promise.resolve(spec.run(...argsByKeys(ctx.args, spec.runArgKeys))).catch(toolError)
  const raw = typeof value === "string" ? value : JSON.stringify(value) ?? String(value)
  const previewChars = spec.previewChars ?? 200
  const preview = previewChars === 0 ? raw : raw.slice(0, previewChars)
  console.log(`[${spec.name} result]`, preview)
  const content = raw || spec.emptyFallback || raw
  const emitArgs = spec.emitArgKeys ? pickArgsByKeys(ctx.args, spec.emitArgKeys) : ctx.args
  recordToolResult(ctx.convId, ctx.state, ctx.call, spec.name, emitArgs, content)
  const message = ctx.state.context.items.at(-1)
  if (message?.role === "toolResult") {
    const refs = await toolContextImageReferences(spec.name, ctx.args, content, ctx.state.services?.persistence?.getDb(), ctx.state.services?.persistence?.home).catch(() => [])
    if (refs.length) {
      ctx.state.context = ctx.state.context.edit(
        ctx.state.context.items.length - 1,
        { ...message, imageReferences: refs },
      )
    }
  }
  return {}
}

export async function executeToolCall(
  convId: number,
  state: LoopState,
  hooks: LoopHooks,
  legacyHandlersOrCall: Record<string, never> | FunctionToolCall,
  maybeCall?: FunctionToolCall,
): Promise<ToolExecutionOutcome> {
  const call = maybeCall ?? legacyHandlersOrCall as FunctionToolCall
  // Pi args are already a parsed object — no JSON parsing needed.
  const args: ToolArgs = call.arguments as ToolArgs

  if ((call.name === "wait" || call.name === "end_session") && latestAssistantContent(state).length === 0) {
    console.warn(
      `[runner] ${call.name} called with empty assistant content; allowing tool-only turn (provider emitted no text).`,
    )
  }

  const isWaitTool = call.name === "wait" || call.name === "wait_then_continue"
  if (!isWaitTool) state.toolInFlight = true
  state.services?.discord?.beginToolWait(state.discordTypingTurnId ?? "")

  try {
    if (state.runtimeKind === "frontend" && FRONTEND_HARD_DENY.has(call.name)) {
      const errorText = `error: tool ${call.name} is forbidden in the frontend runtime`
      recordToolResult(convId, state, call, call.name, { _forbidden_tool: call.name }, errorText)
      return {}
    }
    const advertised = state.toolCatalog.some((tool) => tool.function.name === call.name)
    if (!advertised) {
      const errorText = `error: tool ${call.name} is unavailable in this runtime's pinned tool catalog`
      recordToolResult(convId, state, call, call.name, { _unavailable_tool: call.name }, errorText)
      return {}
    }
    if (state.services?.tools) {
      const result = await state.services.tools.execute(call.name, args, {
        signal: state.operationSignal ?? NEVER_ABORTED,
        runtimeKind: state.runtimeKind,
        convId,
        state,
        hooks,
        call,
        args,
      })
      if (result && typeof result === "object" && ("shouldRest" in result || "shouldWaitForEvent" in result || "isWait" in result)) {
        return result as ToolExecutionOutcome
      }
      if (!hasToolResponse(state, call)) {
        const content = typeof result === "string" ? result : JSON.stringify(result)
        recordToolResult(convId, state, call, call.name, args, content ?? "")
      }
      return {}
    }
    const errorText = `error: tool service unavailable for ${call.name}`
    recordToolResult(convId, state, call, call.name, { _unavailable_tool: call.name }, errorText)
    return {}
  } catch (err) {
    const errorText = toolError(err)
    if (!hasToolResponse(state, call)) {
      recordToolResult(convId, state, call, call.name, { _handler_error: true }, errorText)
    } else {
      console.warn(`[runner] ${call.name} failed after recording tool response: ${errorText}`)
    }
    return {}
  } finally {
    state.services?.discord?.endToolWait(state.discordTypingTurnId ?? "")
    if (!isWaitTool) {
      state.toolInFlight = false
      hooks.flushDeferredEvents()
    }
  }
}
