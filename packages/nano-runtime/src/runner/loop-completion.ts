import { ContextChangedError } from "../llm"
import type { AssistantMessage, AssistantMessageEvent, TextContent, ThinkingContent, Usage } from "../llm"
import type { ToolDefinition } from "@nano/harness-core"
import { logMessage } from "../db"
import { setContextSize } from "../discord/status-updater"
import { buildCompletionMessages, rememberRecalledMemoryChunks } from "../memory"
import { recordMetric, summarizePromptResponse } from "../metrics"
import { recordLlmRequest } from "../prometheus"
import { emit } from "../stream"
import { notifyDiscordModelActivity } from "../discord/typing-lease"
import { modelStateFor } from "./model-state"
import type { LoopState } from "./types"
import {
  errorSummary,
  estimatePromptTokens,
  fallbackContextWindow,
  findSummaryMessageIndex,
  isContentFilterError,
  isImageParseError,
  isPromptTooLargeError,
  loadAgentSummaryContext,
  retryDelayMs,
  sanitizeMessages,
  scrubImagesFromConversation,
  shouldFallback,
  summarizeConversationViaLLM,
} from "./util"
import { getCompletionTools } from "./tools"
import type { CompletionTurnResult } from "./loop-shared"
import type { Model } from "../llm"
import { classifyApiError } from "../api-errors"
import { reportApiError } from "../discord/owner-alerts"

/** The currently active model pair (fallback when degraded, else primary). */
export function activeModelProvider(state?: Pick<LoopState, "runtimeKind">): { model: Model | null; apiKey: string | undefined } {
  const modelState = modelStateFor(state?.runtimeKind)
  return {
    model: modelState.useFallback ? modelState.fallbackModel : modelState.primaryModel,
    apiKey: modelState.useFallback ? modelState.fallbackApiKey : modelState.primaryApiKey,
  }
}

/**
 * Resolves the summary model pair for a compaction pass.
 *
 * `"active"` (companion / context-full strategies) forces the model
 * that actually generated the conversation, so the summary is written from the
 * same head that holds the reasoning — the only way to salvage lessons from a
 * provider that hides its chain-of-thought. Otherwise a configured `summary`
 * preset is preferred (cheap dedicated summarizer), falling back to active.
 *
 * When prompt-cache preservation is on AND we are not explicitly preferring the
 * active model, we return null so an incidental summary can't invalidate the
 * cached prefix. An intentional cliff-defense compaction passes
 * `"active"` and accepts the one-time cache bust. `"configured"` is the
 * operator-forced small-model path and never falls back to the active model.
 */
export type SummaryProviderPreference = "default" | "active" | "configured"

export function configuredSummaryProvider(
  preference: SummaryProviderPreference = "default",
  state?: Pick<LoopState, "runtimeKind">,
): { model: Model | null; apiKey: string | undefined } {
  const modelState = modelStateFor(state?.runtimeKind)
  if (preference === "active") return activeModelProvider(state)
  // An explicit /compact force=true means exactly the configured small model:
  // do not substitute the active model and do not suppress the intentional
  // cache bust. The Discord handler rejects this mode when no model exists.
  if (preference === "configured") {
    return { model: modelState.summaryModel, apiKey: modelState.summaryApiKey }
  }
  if (modelState.respectPromptCache) return { model: null, apiKey: undefined }
  if (modelState.summaryModel) return { model: modelState.summaryModel, apiKey: modelState.summaryApiKey }
  return activeModelProvider(state)
}

/**
 * Persists an assistant message after Context.complete appended it atomically.
 */
export function addAssistantMessage(convId: number, msg: AssistantMessage): void {
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
): void {
  recordMetric({
    type: "prompt_response",
    model,
    toolChoice,
    ...summarizePromptResponse(state.context.items.slice(0, -1), result.message),
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
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite
  if (promptTokens > 0) {
    state.contextSize = promptTokens
    setContextSize(state.contextSize)
  }
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
    cachedPromptTokens: usage.cacheRead || undefined,
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

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error("Request was aborted")
}

async function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms)
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      signal!.removeEventListener("abort", abort)
      resolve()
    }
    function abort(): void {
      clearTimeout(timer)
      signal!.removeEventListener("abort", abort)
      reject(signal!.reason instanceof Error ? signal!.reason : new Error("Request was aborted"))
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

/**
 * Streams one completion from a model.
 */
async function createStreamedCompletion(
  model: Model,
  apiKey: string | undefined,
  toolChoice: "required" | "auto" | "none",
  state: LoopState,
  tools?: ToolDefinition[],
  signal?: AbortSignal,
): Promise<CompletionTurnResult> {
  const modelState = modelStateFor(state.runtimeKind)
  const startedAt = Date.now()
  const resolvedToolChoice = modelState.enableThinking && toolChoice === "required" ? "auto" : toolChoice
  const completionTools = getCompletionTools(tools, state.runtimeKind)
  const modelChanged = JSON.stringify(state.context.model) !== JSON.stringify(model)
  const toolsChanged = JSON.stringify(state.context.tools ?? []) !== JSON.stringify(completionTools)
  const settingsChanged =
    modelChanged ||
    toolsChanged ||
    state.context.apiKey !== apiKey ||
    state.context.toolChoice !== resolvedToolChoice ||
    state.context.thinkingLevel !== (modelState.enableThinking ? modelState.thinkingEffort : undefined) ||
    state.context.includeContextImages !== modelState.primaryVision
  if (settingsChanged) {
    state.context = state.context.fork({
      model,
      apiKey,
      tools: completionTools,
      toolChoice: resolvedToolChoice,
      thinkingLevel: modelState.enableThinking ? modelState.thinkingEffort : undefined,
      includeContextImages: modelState.primaryVision,
      reason: modelChanged ? "model-change" : toolsChanged ? "tools-change" : "settings-change",
    })
  }

  let emittedText = false
  let emittedThinking = false
  let bufferedThinking = ""
  const completionContext = state.context
  const finalMessage = await completionContext.complete({
    captureCacheWarmRequest: modelState.cacheWarming && !modelState.useFallback,
    ...(signal ? { signal } : {}),
    onEvent: (event: AssistantMessageEvent) => {
      if (event.type === "text_delta") {
        notifyDiscordModelActivity(state.discordTypingTurnId ?? "")
        emit({ type: "text", text: event.delta })
        emittedText = true
      } else if (event.type === "thinking_start") {
        notifyDiscordModelActivity(state.discordTypingTurnId ?? "")
        bufferedThinking = ""
      } else if (event.type === "thinking_delta") {
        notifyDiscordModelActivity(state.discordTypingTurnId ?? "")
        if (modelState.enableThinking) bufferedThinking += event.delta
      } else if (event.type === "thinking_end") {
        if (modelState.enableThinking && bufferedThinking) {
          emit({ type: "thinking", text: bufferedThinking })
          emittedThinking = true
        }
      }
    },
  })
  if (state.context !== completionContext) {
    throw new ContextChangedError("Context was replaced while completion was in flight; refusing a stale assistant response")
  }

  const usage = finalMessage.usage
  const elapsedMs = Math.max(0, Date.now() - startedAt)
  const tokensPerSecond = usage.output && elapsedMs > 0 ? usage.output / (elapsedMs / 1000) : undefined

  recordLlmRequest(model.id, "success", usage, tokensPerSecond)

  recordPromptResponse(model.id, toolChoice, state, { message: finalMessage, usage, emittedText, emittedThinking, bufferedThinking, elapsedMs, tokensPerSecond })

  return { message: finalMessage, usage, emittedText, emittedThinking, bufferedThinking, elapsedMs, tokensPerSecond }
}
async function createFallbackCompletion(state: LoopState, tools?: ToolDefinition[], signal?: AbortSignal): Promise<CompletionTurnResult> {
  const modelState = modelStateFor(state.runtimeKind)
  return createStreamedCompletion(modelState.fallbackModel, modelState.fallbackApiKey, modelState.fallbackToolChoice, state, tools, signal)
}
async function createPrimaryCompletion(state: LoopState, tools?: ToolDefinition[], signal?: AbortSignal): Promise<CompletionTurnResult> {
  const modelState = modelStateFor(state.runtimeKind)
  return createStreamedCompletion(modelState.primaryModel!, modelState.primaryApiKey, modelState.primaryToolChoice, state, tools, signal)
}

function logPromptSizeDebug(state: LoopState, errMsg: string, label: string): void {
  const messageCount = state.context.items.length
  const estimate = estimatePromptTokens(state.context.items)
  const charLength = JSON.stringify(state.context.items).length
  console.warn(
    `[api] ${label}: ${errMsg} - messages=${messageCount} est_tokens=${estimate} chars=${charLength} observedPromptTokens=${state.contextSize}`,
  )
}

function noteApiError(errorMessage: string, role: "primary" | "fallback", model: Model) {
  const classified = classifyApiError(errorMessage, {
    role,
    model: model.id,
    provider: model.provider,
    baseUrl: model.baseUrl,
  })
  void reportApiError(classified)
  return classified
}

async function recoverFromPromptTooLarge(state: LoopState, attempt: number): Promise<boolean> {
  const modelState = modelStateFor(state.runtimeKind)
  const beforeEstimate = estimatePromptTokens(state.context.items)
  const summaryProvider = configuredSummaryProvider("default", state)
  if (!summaryProvider.model) {
    console.warn(`[context] recovery: no summary model available; cannot llm-summarize`)
    return false
  }

  console.warn(`[context] recovery: attempting llm summarization via ${summaryProvider.model.id} (attempt=${attempt + 1})`)
  const agentContext = await loadAgentSummaryContext(state.runtimeKind)
  const summarized = await summarizeConversationViaLLM(
    state.context.items,
    summaryProvider.model,
    summaryProvider.apiKey,
    {
      agentContext,
      primaryHandoff: summaryProvider.model === modelState.summaryModel,
    },
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

  state.context = state.context.fork({ items: summarized, reason: "compaction" })
  state.contextSize = afterEstimate

  const summaryIdx = findSummaryMessageIndex(state.context.items)
  const summary = summaryIdx >= 0 ? (state.context.items[summaryIdx]?.role === "user"
    ? (typeof (state.context.items[summaryIdx] as { content: unknown }).content === "string"
      ? (state.context.items[summaryIdx] as { content: string }).content
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
  tools?: ToolDefinition[],
  _baseState: LoopState = state,
  signal?: AbortSignal,
): Promise<CompletionTurnResult> {
  const modelState = modelStateFor(state.runtimeKind)
  let promptTooLargeAttempts = 0
  let imagesScrubbed = false
  let recallPrepared = false
  let recalledChunkIds: number[] = []

  const recoverByScrubbingImages = (errMsg: string, label: string): boolean => {
    if (imagesScrubbed) return false
    if (!isContentFilterError(errMsg) && !isImageParseError(errMsg)) return false
    const reason = isContentFilterError(errMsg) ? "content-filter rejection" : "image parse/format rejection"
    const scrubbedMessages = state.context.snapshot()
    const scrubbed = scrubImagesFromConversation(scrubbedMessages)
    imagesScrubbed = true
    if (scrubbed > 0) {
      state.context = state.context.fork({ items: scrubbedMessages, reason: "image-scrub" })
      console.warn(`[api] ${label} ${reason}; scrubbed ${scrubbed} image attachment(s) and retrying`)
      return true
    }
    console.warn(`[api] ${label} ${reason} but no images found to scrub`)
    return false
  }

  while (true) {
    throwIfAborted(signal)
    const currentMessages = state.context.snapshot()
    const sanitized = sanitizeMessages(currentMessages)
    if (JSON.stringify(sanitized) !== JSON.stringify(currentMessages)) {
      state.context = state.context.fork({ items: sanitized, reason: "sanitize" })
    }

    if (state.memoryRecallPending && !recallPrepared) {
      const recalled = await buildCompletionMessages(state.context.snapshot(), state.memoryRecallCooldowns, state.memoryRecallTurn)
      recalledChunkIds = recalled.recalledChunkIds
      if (recalled.messages.length > state.context.items.length) {
        state.context.append(recalled.messages.slice(state.context.items.length))
      }
      recallPrepared = true
    }

    if (modelState.useFallback) {
      const fallbackWindow = fallbackContextWindow(state.context.items)
      if (fallbackWindow.nearLimit) {
        console.warn(`[fallback] prompt estimate ${fallbackWindow.estimate} nearing fallback limit ${fallbackWindow.softLimit} (${modelState.fallbackModel.id})`)
      }

      try {
        const completion = await createFallbackCompletion(state, tools, signal)
        state.memoryRecallCooldowns = rememberRecalledMemoryChunks(state.memoryRecallCooldowns, recalledChunkIds, state.memoryRecallTurn)
        state.memoryRecallPending = false
        return completion
      } catch (fallbackErr) {
        throwIfAborted(signal)
        if (fallbackErr instanceof ContextChangedError) {
          console.warn("[context] changed during fallback completion; retrying from the new tail")
          continue
        }
        const errMsg = errorSummary(fallbackErr)
        const failure = noteApiError(errMsg, "fallback", modelState.fallbackModel)
        if (isPromptTooLargeError(errMsg) && promptTooLargeAttempts < 2) {
          logPromptSizeDebug(state, errMsg, `fallback rejected prompt (attempt ${promptTooLargeAttempts + 1}/2)`)
          const recovered = await recoverFromPromptTooLarge(state, promptTooLargeAttempts)
          promptTooLargeAttempts++
          if (recovered) continue
        }
        if (recoverByScrubbingImages(errMsg, "fallback")) continue
        if (failure.terminal) {
          console.error(`[api] terminal fallback error: ${errMsg} model=${modelState.fallbackModel.id} api=${modelState.fallbackModel.baseUrl}`)
          recordLlmRequest(modelState.fallbackModel.id, "error", null)
          throw fallbackErr
        }
        if (shouldFallback(errMsg)) {
          console.warn(`[fallback] transient failure (${errMsg}); retrying after ${Math.ceil(retryDelayMs / 1000)}s`)
          await interruptibleSleep(retryDelayMs, signal)
          continue
        }
        console.error(`[api] fallback error: ${errMsg} model=${modelState.fallbackModel.id} api=${modelState.fallbackModel.baseUrl}`)
        recordLlmRequest(modelState.fallbackModel.id, "error", null)
        throw fallbackErr
      }
    }

    try {
      const completion = await createPrimaryCompletion(state, tools, signal)
      state.memoryRecallCooldowns = rememberRecalledMemoryChunks(state.memoryRecallCooldowns, recalledChunkIds, state.memoryRecallTurn)
      state.memoryRecallPending = false
      return completion
    } catch (primaryErr) {
      throwIfAborted(signal)
      if (primaryErr instanceof ContextChangedError) {
        console.warn("[context] changed during primary completion; retrying from the new tail")
        continue
      }
      const errMsg = errorSummary(primaryErr)
      const primaryFailure = noteApiError(errMsg, "primary", modelState.primaryModel!)
      if (isPromptTooLargeError(errMsg) && promptTooLargeAttempts < 2) {
        logPromptSizeDebug(state, errMsg, `primary rejected prompt (attempt ${promptTooLargeAttempts + 1}/2)`)
        const recovered = await recoverFromPromptTooLarge(state, promptTooLargeAttempts)
        promptTooLargeAttempts++
        if (recovered) continue
        throw primaryErr
      }

      if (recoverByScrubbingImages(errMsg, "primary")) continue

      if (!primaryFailure.terminal && !shouldFallback(errMsg)) {
        const primaryId = modelState.primaryModel?.id ?? "(unknown)"
        const primaryBase = modelState.primaryModel?.baseUrl ?? "(unknown)"
        console.error(`[api] primary error: ${errMsg} model=${primaryId} api=${primaryBase}`)
        recordLlmRequest(primaryId, "error", null)
        throw primaryErr
      }

      const fallbackWindow = fallbackContextWindow(state.context.items)
      if (fallbackWindow.skip) {
        if (primaryFailure.terminal) throw primaryErr
        console.warn(`[api] primary down (${errMsg}) and fallback context estimate ${fallbackWindow.estimate} exceeds hard limit; retrying primary after backoff`)
        await interruptibleSleep(retryDelayMs, signal)
        continue
      }

      if (fallbackWindow.nearLimit) {
        console.warn(`[fallback] prompt estimate ${fallbackWindow.estimate} nearing fallback limit ${fallbackWindow.softLimit} (${modelState.fallbackModel.id})`)
      }

      console.warn(`[api] primary down (${errMsg}) - switching to fallback`)
      try {
        const completion = await createFallbackCompletion(state, tools, signal)
        state.memoryRecallCooldowns = rememberRecalledMemoryChunks(state.memoryRecallCooldowns, recalledChunkIds, state.memoryRecallTurn)
        state.memoryRecallPending = false
        return completion
      } catch (fallbackErr) {
        throwIfAborted(signal)
        if (fallbackErr instanceof ContextChangedError) {
          console.warn("[context] changed during fallback failover; retrying from the new tail")
          continue
        }
        const fallbackErrMsg = errorSummary(fallbackErr)
        const fallbackFailure = noteApiError(fallbackErrMsg, "fallback", modelState.fallbackModel)
        if (isPromptTooLargeError(fallbackErrMsg) && promptTooLargeAttempts < 2) {
          logPromptSizeDebug(state, fallbackErrMsg, `fallback rejected prompt during failover (attempt ${promptTooLargeAttempts + 1}/2)`)
          const recovered = await recoverFromPromptTooLarge(state, promptTooLargeAttempts)
          promptTooLargeAttempts++
          if (recovered) continue
        }
        if (recoverByScrubbingImages(fallbackErrMsg, "fallback-failover")) continue
        if (primaryFailure.terminal || fallbackFailure.terminal) {
          console.error(`[api] failover stopped after terminal error: primary=${errMsg} fallback=${fallbackErrMsg}`)
          recordLlmRequest(modelState.fallbackModel.id, "error", null)
          throw primaryFailure.terminal ? primaryErr : fallbackErr
        }
        console.warn(`[api] fallback failed (${fallbackErrMsg}) after primary failure (${errMsg}); retrying primary after backoff`)
        await interruptibleSleep(retryDelayMs, signal)
      }
    }
  }
}
