import { stream } from "@earendil-works/pi-ai"
import type { AssistantMessage, AssistantMessageEvent, TextContent, ThinkingContent, Usage } from "@earendil-works/pi-ai"
import type { OpenAICompletionsOptions } from "@earendil-works/pi-ai/openai-completions"
import { logMessage } from "../db"
import { buildCompletionMessages, rememberRecalledMemoryChunks } from "../memory"
import { recordMetric } from "../metrics"
import { emit } from "../stream"
import type { LoopState } from "./types"
import {
  API_BASE,
  ENABLE_THINKING,
  FALLBACK_API_KEY,
  FALLBACK_BASE,
  FALLBACK_MODEL,
  FALLBACK_TOOL_CHOICE,
  MODEL,
  PRIMARY_API_KEY,
  PRIMARY_TOOL_CHOICE,
  SUMMARY_API_KEY,
  SUMMARY_MODEL,
  THINKING_EFFORT,
  USE_FALLBACK,
  buildContext,
  errorSummary,
  estimatePromptTokens,
  fallbackContextWindow,
  fallbackModel,
  findSummaryMessageIndex,
  isContentFilterError,
  isImageParseError,
  isPromptTooLargeError,
  loadAgentSummaryContext,
  primaryModel,
  retryDelayMs,
  sanitizeMessages,
  scrubImagesFromConversation,
  shouldFallback,
  summaryModel,
  summarizeConversationViaLLM,
} from "./util"
import type { CompletionTurnResult } from "./loop-shared"
import type { Model } from "@earendil-works/pi-ai"

/**
 * Resolves the configured summary model pair.
 */
export function configuredSummaryProvider(): { model: Model<"openai-completions"> | null; apiKey: string | undefined } {
  if (summaryModel && SUMMARY_MODEL) return { model: summaryModel, apiKey: SUMMARY_API_KEY }
  return {
    model: USE_FALLBACK ? fallbackModel : primaryModel,
    apiKey: USE_FALLBACK ? FALLBACK_API_KEY : PRIMARY_API_KEY,
  }
}

/**
 * Appends an assistant message to state and persists it to conversation logs.
 */
export function addAssistantMessage(convId: number, state: LoopState, msg: AssistantMessage): void {
  state.conversation.push(msg)
  const textContent = msg.content
    .filter((p): p is TextContent => p.type === "text")
    .map((p) => p.text)
    .join("")
  const toolCalls = msg.content
    .filter((p) => p.type === "toolCall")
    .map((p) => p)
  logMessage(convId, msg.role, textContent, toolCalls.length > 0 ? toolCalls : undefined)
}

function recordPromptResponse(
  model: string,
  toolChoice: string | undefined,
  state: LoopState,
  result: CompletionTurnResult,
  promptMetricId: number | null,
): void {
  recordMetric({
    type: "prompt_response",
    promptMetricId: promptMetricId ?? undefined,
    model,
    toolChoice,
    messages: state.conversation as import("../types").Message[],
    response: result.message,
    usage: result.usage,
  })
}

/**
 * Applies token usage from a completion response to loop state counters.
 */
export function applyUsage(
  state: LoopState,
  usage: Usage,
  timing: Pick<CompletionTurnResult, "elapsedMs" | "tokensPerSecond"> = {},
): void {
  state.tokenCount += usage.totalTokens
  if (usage.input) state.contextSize = usage.input + usage.cacheRead
  const rate = typeof timing.tokensPerSecond === "number" ? ` ${timing.tokensPerSecond.toFixed(1)} tok/s` : ""
  console.log(
    `[tokens] +${usage.totalTokens} total=${state.tokenCount}` +
    (usage.cacheRead ? ` cache_read=${usage.cacheRead}` : "") +
    (usage.cacheWrite ? ` cache_write=${usage.cacheWrite}` : "") +
    rate,
  )
  emit({
    type: "usage",
    promptTokens: usage.input,
    completionTokens: usage.output,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheRead || undefined,
    cacheWriteTokens: usage.cacheWrite || undefined,
    elapsedMs: timing.elapsedMs,
    tokensPerSecond: timing.tokensPerSecond,
  })
  recordMetric({ type: "usage", usage })
}

/**
 * Emits model reasoning/thinking when present in the assistant message.
 */
export function emitThinking(msg: AssistantMessage): void {
  const thinking = msg.content
    .filter((c): c is ThinkingContent => c.type === "thinking")
    .map((c) => c.thinking)
    .join("")
    .trim()
  if (thinking) emit({ type: "thinking", text: thinking })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatRetryAt(retryAfterMs: number): string {
  const retryAt = new Date(Date.now() + retryAfterMs)
  return retryAt.toLocaleString(undefined, { hour12: false, timeZoneName: "short" })
}

/**
 * Streams one completion from a pi-ai model.
 */
async function createStreamedCompletion(
  model: Model<"openai-completions">,
  apiKey: string | undefined,
  toolChoice: "required" | "auto" | "none",
  state: LoopState,
): Promise<CompletionTurnResult> {
  const startedAt = Date.now()
  const context = buildContext(state)

  const resolvedToolChoice = ENABLE_THINKING && toolChoice === "required" ? "auto" : toolChoice
  const options: OpenAICompletionsOptions = {
    ...(apiKey ? { apiKey } : {}),
    toolChoice: resolvedToolChoice,
    ...(ENABLE_THINKING ? { reasoningEffort: THINKING_EFFORT } : {}),
  }

  const promptMetricId = recordMetric({ type: "prompt", messages: state.conversation as import("../types").Message[] })
  const eventStream = stream(model, context, options as unknown as import("@earendil-works/pi-ai").ProviderStreamOptions)

  let emittedText = false
  let emittedThinking = false
  let bufferedThinking = ""
  let errorMessage: string | undefined

  for await (const event of eventStream as AsyncIterable<AssistantMessageEvent>) {
    if (event.type === "text_delta") {
      emit({ type: "text", text: event.delta })
      emittedText = true
    } else if (event.type === "thinking_start") {
      bufferedThinking = ""
    } else if (event.type === "thinking_delta") {
      if (ENABLE_THINKING) bufferedThinking += event.delta
    } else if (event.type === "thinking_end") {
      if (ENABLE_THINKING && bufferedThinking) {
        emit({ type: "thinking", text: bufferedThinking })
        emittedThinking = true
      }
    } else if (event.type === "error") {
      errorMessage = event.error.errorMessage ?? "unknown API error"
    }
  }

  const finalMessage = await (eventStream as { result(): Promise<AssistantMessage> }).result()

  if (finalMessage.stopReason === "error" || errorMessage) {
    throw new Error(errorMessage ?? finalMessage.errorMessage ?? "unknown API error")
  }

  const usage = finalMessage.usage
  const elapsedMs = Math.max(0, Date.now() - startedAt)
  const tokensPerSecond = usage.output && elapsedMs > 0 ? usage.output / (elapsedMs / 1000) : undefined

  recordPromptResponse(model.id, toolChoice, state, { message: finalMessage, usage, emittedText, emittedThinking, bufferedThinking, elapsedMs, tokensPerSecond }, promptMetricId)

  return { message: finalMessage, usage, emittedText, emittedThinking, bufferedThinking, elapsedMs, tokensPerSecond }
}

async function createFallbackCompletion(state: LoopState): Promise<CompletionTurnResult> {
  return createStreamedCompletion(fallbackModel, FALLBACK_API_KEY, FALLBACK_TOOL_CHOICE, state)
}

async function createPrimaryCompletion(state: LoopState): Promise<CompletionTurnResult> {
  return createStreamedCompletion(primaryModel!, PRIMARY_API_KEY, PRIMARY_TOOL_CHOICE, state)
}

function logPromptSizeDebug(state: LoopState, errMsg: string, label: string): void {
  const messageCount = state.conversation.length
  const estimate = estimatePromptTokens(state.conversation)
  const charLength = JSON.stringify(state.conversation).length
  console.warn(
    `[api] ${label}: ${errMsg} - messages=${messageCount} est_tokens=${estimate} chars=${charLength} observedPromptTokens=${state.contextSize}`,
  )
}

async function recoverFromPromptTooLarge(state: LoopState, attempt: number): Promise<boolean> {
  const beforeEstimate = estimatePromptTokens(state.conversation)
  const summaryProvider = configuredSummaryProvider()
  if (!summaryProvider.model) {
    console.warn(`[context] recovery: no summary model available; cannot llm-summarize`)
    return false
  }

  console.warn(`[context] recovery: attempting llm summarization via ${summaryProvider.model.id} (attempt=${attempt + 1})`)
  const agentContext = await loadAgentSummaryContext()
  const summarized = await summarizeConversationViaLLM(
    state.conversation,
    summaryProvider.model,
    summaryProvider.apiKey,
    { agentContext },
  )
  if (!summarized) {
    console.warn(`[context] recovery: llm summarization returned no changes`)
    return false
  }

  const afterEstimate = estimatePromptTokens(summarized)
  if (afterEstimate >= beforeEstimate) {
    console.warn(`[context] recovery: llm summary not smaller (${beforeEstimate} -> ${afterEstimate}); keeping original`)
    return false
  }

  state.conversation = summarized
  state.contextSize = afterEstimate

  const summaryIdx = findSummaryMessageIndex(state.conversation)
  const summary = summaryIdx >= 0 ? (state.conversation[summaryIdx]?.role === "user"
    ? (typeof (state.conversation[summaryIdx] as { content: unknown }).content === "string"
      ? (state.conversation[summaryIdx] as { content: string }).content
      : undefined)
    : undefined) : undefined

  console.warn(`[context] recovery: llm-summarized conversation (${beforeEstimate} -> ${afterEstimate} tokens)`)
  recordMetric({ type: "compaction", before: beforeEstimate, after: afterEstimate, method: "force-llm", summary })
  return true
}

/**
 * Fetches the next assistant completion, including fallback and backoff behavior.
 */
export async function fetchCompletion(
  state: LoopState,
  baseState: LoopState = state,
): Promise<CompletionTurnResult> {
  let promptTooLargeAttempts = 0
  let imagesScrubbed = false

  const recoverByScrubbingImages = (errMsg: string, label: string): boolean => {
    if (imagesScrubbed) return false
    if (!isContentFilterError(errMsg) && !isImageParseError(errMsg)) return false
    const reason = isContentFilterError(errMsg) ? "content-filter rejection" : "image parse/format rejection"
    const scrubbed = scrubImagesFromConversation(state.conversation)
    imagesScrubbed = true
    if (scrubbed > 0) {
      console.warn(`[api] ${label} ${reason}; scrubbed ${scrubbed} image attachment(s) and retrying`)
      return true
    }
    console.warn(`[api] ${label} ${reason} but no images found to scrub`)
    return false
  }

  while (true) {
    state.conversation = sanitizeMessages(state.conversation)

    const requestState = state.memoryRecallPending
      ? await (async () => {
          const ctx = await buildCompletionMessages(state.conversation, state.memoryRecallCooldowns, state.memoryRecallTurn)
          return { ...state, conversation: ctx.messages, _recalledChunkIds: ctx.recalledChunkIds }
        })()
      : { ...state, _recalledChunkIds: [] as number[] }

    const recalledChunkIds = (requestState as typeof requestState & { _recalledChunkIds: number[] })._recalledChunkIds

    if (USE_FALLBACK) {
      const fallbackWindow = fallbackContextWindow(requestState.conversation)
      if (fallbackWindow.nearLimit) {
        console.warn(`[fallback] prompt estimate ${fallbackWindow.estimate} nearing fallback limit ${fallbackWindow.softLimit} (${FALLBACK_MODEL})`)
      }

      try {
        const completion = await createFallbackCompletion(requestState)
        state.memoryRecallCooldowns = rememberRecalledMemoryChunks(state.memoryRecallCooldowns, recalledChunkIds, state.memoryRecallTurn)
        state.memoryRecallPending = false
        return completion
      } catch (fallbackErr) {
        const errMsg = errorSummary(fallbackErr)
        if (isPromptTooLargeError(errMsg) && promptTooLargeAttempts < 2) {
          logPromptSizeDebug(state, errMsg, `fallback rejected prompt (attempt ${promptTooLargeAttempts + 1}/2)`)
          const recovered = await recoverFromPromptTooLarge(state, promptTooLargeAttempts)
          promptTooLargeAttempts++
          if (recovered) continue
        }
        if (recoverByScrubbingImages(errMsg, "fallback")) continue
        if (shouldFallback(errMsg)) {
          console.warn(`[fallback] transient failure (${errMsg}); retrying after ${Math.ceil(retryDelayMs / 1000)}s`)
          await sleep(retryDelayMs)
          continue
        }
        console.error(`[api] fallback error: ${errMsg} model=${FALLBACK_MODEL} api=${FALLBACK_BASE}`)
        throw fallbackErr
      }
    }

    try {
      const completion = await createPrimaryCompletion(requestState)
      state.memoryRecallCooldowns = rememberRecalledMemoryChunks(state.memoryRecallCooldowns, recalledChunkIds, state.memoryRecallTurn)
      state.memoryRecallPending = false
      return completion
    } catch (primaryErr) {
      const errMsg = errorSummary(primaryErr)
      if (isPromptTooLargeError(errMsg) && promptTooLargeAttempts < 2) {
        logPromptSizeDebug(state, errMsg, `primary rejected prompt (attempt ${promptTooLargeAttempts + 1}/2)`)
        const recovered = await recoverFromPromptTooLarge(state, promptTooLargeAttempts)
        promptTooLargeAttempts++
        if (recovered) continue
        throw primaryErr
      }

      if (recoverByScrubbingImages(errMsg, "primary")) continue

      if (!shouldFallback(errMsg)) {
        console.error(`[api] primary error: ${errMsg} model=${MODEL} api=${API_BASE}`)
        throw primaryErr
      }

      const fallbackWindow = fallbackContextWindow(requestState.conversation)
      if (fallbackWindow.skip) {
        console.warn(`[api] primary down (${errMsg}) and fallback context estimate ${fallbackWindow.estimate} exceeds hard limit; retrying primary after backoff`)
        await sleep(retryDelayMs)
        continue
      }

      if (fallbackWindow.nearLimit) {
        console.warn(`[fallback] prompt estimate ${fallbackWindow.estimate} nearing fallback limit ${fallbackWindow.softLimit} (${FALLBACK_MODEL})`)
      }

      console.warn(`[api] primary down (${errMsg}) - switching to fallback`)
      try {
        const completion = await createFallbackCompletion(requestState)
        state.memoryRecallCooldowns = rememberRecalledMemoryChunks(state.memoryRecallCooldowns, recalledChunkIds, state.memoryRecallTurn)
        state.memoryRecallPending = false
        return completion
      } catch (fallbackErr) {
        const fallbackErrMsg = errorSummary(fallbackErr)
        if (isPromptTooLargeError(fallbackErrMsg) && promptTooLargeAttempts < 2) {
          logPromptSizeDebug(state, fallbackErrMsg, `fallback rejected prompt during failover (attempt ${promptTooLargeAttempts + 1}/2)`)
          const recovered = await recoverFromPromptTooLarge(state, promptTooLargeAttempts)
          promptTooLargeAttempts++
          if (recovered) continue
        }
        if (recoverByScrubbingImages(fallbackErrMsg, "fallback-failover")) continue
        console.warn(`[api] fallback failed (${fallbackErrMsg}) after primary failure (${errMsg}); retrying primary after backoff`)
        await sleep(retryDelayMs)
      }
    }
  }
}
