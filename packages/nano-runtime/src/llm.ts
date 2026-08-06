/**
 * LLM client module — replaces @earendil-works/pi-ai with direct openai npm usage.
 *
 * Exports the same types and function signatures the harness code expects,
 * but backed by the `openai` npm package instead of pi-ai's provider abstraction.
 */

import OpenAI from "openai"

// ── Content part types ────────────────────────────────────────────────────────

export interface TextContent {
  type: "text"
  text: string
  textSignature?: string
}

export interface ThinkingContent {
  type: "thinking"
  thinking: string
  thinkingSignature?: string
  redacted?: boolean
}

export interface ImageContent {
  type: "image"
  data: string // base64 encoded
  mimeType: string
}

export interface ToolCall {
  type: "toolCall"
  id: string
  name: string
  arguments: Record<string, any>
  thoughtSignature?: string
}

// ── Usage ─────────────────────────────────────────────────────────────────────

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}

// ── Stop reason ───────────────────────────────────────────────────────────────

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted"

// ── Message types ──────────────────────────────────────────────────────────────

export interface UserMessage {
  role: "user"
  content: string | (TextContent | ImageContent)[]
  timestamp: number
}

export interface AssistantMessage {
  role: "assistant"
  content: (TextContent | ThinkingContent | ToolCall)[]
  api: string
  provider: string
  model: string
  responseModel?: string
  responseId?: string
  usage: Usage
  stopReason: StopReason
  errorMessage?: string
  timestamp: number
}

export interface ToolResultMessage<TDetails = any> {
  role: "toolResult"
  toolCallId: string
  toolName: string
  content: (TextContent | ImageContent)[]
  details?: TDetails
  isError: boolean
  timestamp: number
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage

// ── Model ──────────────────────────────────────────────────────────────────────

export interface Model {
  id: string
  name: string
  api: string
  provider: string
  baseUrl: string
  reasoning: boolean
  input: ("text" | "image")[]
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  contextWindow: number
  maxTokens: number
  headers?: Record<string, string>
}

// ── Tool / Schema types ────────────────────────────────────────────────────────

export type TSchema = Record<string, unknown>

export interface Tool<TParameters extends TSchema = TSchema> {
  name: string
  description: string
  parameters: TParameters
}

// ── Context ────────────────────────────────────────────────────────────────────

export interface Context {
  systemPrompt?: string
  messages: Message[]
  tools?: Tool[]
}

// ── Stream options ─────────────────────────────────────────────────────────────

export interface StreamOptions {
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  apiKey?: string
  headers?: Record<string, string>
  timeoutMs?: number
  maxRetries?: number
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>

export interface OpenAICompletionsOptions extends StreamOptions {
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } }
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh"
}

// ── Event protocol ─────────────────────────────────────────────────────────────

export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
  | { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage }

// ── Event stream ──────────────────────────────────────────────────────────────

class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue: T[] = []
  private waiting: ((value: IteratorResult<T>) => void)[] = []
  private done = false
  private finalResultPromise: Promise<R>
  private resolveFinalResult!: (result: R) => void
  private isComplete: (event: T) => boolean
  private extractResult: (event: T) => R

  constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
    this.isComplete = isComplete
    this.extractResult = extractResult
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve
    })
  }

  push(event: T): void {
    if (this.done) return
    if (this.isComplete(event)) {
      this.done = true
      this.resolveFinalResult(this.extractResult(event))
    }
    const waiter = this.waiting.shift()
    if (waiter) {
      waiter({ value: event, done: false })
    } else {
      this.queue.push(event)
    }
  }

  end(result?: R): void {
    this.done = true
    if (result !== undefined) {
      this.resolveFinalResult(result)
    }
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!
      waiter({ value: undefined as any, done: true })
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!
      } else if (this.done) {
        return
      } else {
        const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve))
        if (result.done) return
        yield result.value
      }
    }
  }

  result(): Promise<R> {
    return this.finalResultPromise
  }
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message
        if (event.type === "error") return event.error
        throw new Error("Unexpected event type for final result")
      },
    )
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Best-effort JSON parse for potentially incomplete streaming tool call arguments. */
function parseStreamingJson(partial: string | undefined): Record<string, unknown> {
  if (!partial || partial.trim() === "") return {}
  try {
    return JSON.parse(partial)
  } catch {
    // Try to parse as much as possible by finding complete key-value pairs
    try {
      // Wrap in a try — partial JSON won't parse, but we return empty
      return {}
    } catch {
      return {}
    }
  }
}

/** Create an OpenAI client configured for the model's endpoint. */
function createClient(model: Model, apiKey: string, options?: StreamOptions): OpenAI {
  const headers: Record<string, string> = { ...model.headers, ...options?.headers }
  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    defaultHeaders: Object.keys(headers).length > 0 ? headers : undefined,
    timeout: options?.timeoutMs,
    maxRetries: options?.maxRetries ?? 0,
  })
}

/** Convert our Context messages to OpenAI chat completion message params. */
function convertMessages(
  context: Context,
  model: Model,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const params: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []

  if (context.systemPrompt) {
    const useDeveloperRole = model.reasoning
    const role = useDeveloperRole ? "developer" : "system"
    params.push({
      role: role as "system",
      content: context.systemPrompt,
    })
  }

  for (const msg of context.messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        params.push({ role: "user", content: msg.content })
      } else {
        const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = msg.content.map((item) => {
          if (item.type === "text") {
            return { type: "text", text: item.text }
          } else {
            return {
              type: "image_url",
              image_url: { url: `data:${item.mimeType};base64,${item.data}` },
            }
          }
        })
        if (content.length > 0) params.push({ role: "user", content })
      }
    } else if (msg.role === "assistant") {
      const assistantMsg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: null,
      }

      const textParts = msg.content
        .filter((p): p is TextContent => p.type === "text")
        .filter((p) => p.text.trim().length > 0)
      const textContent = textParts.map((p) => p.text).join("")

      const thinkingParts = msg.content
        .filter((p): p is ThinkingContent => p.type === "thinking")
        .filter((p) => p.thinking.trim().length > 0)

      if (thinkingParts.length > 0) {
        // Send thinking as reasoning_content field (common for OpenAI-compatible providers)
        if (textContent.length > 0) {
          assistantMsg.content = textContent
        }
        const firstSig = thinkingParts[0].thinkingSignature
        const sig = firstSig && firstSig.length > 0 ? firstSig : "reasoning_content"
        ;(assistantMsg as any)[sig] = thinkingParts.map((p) => p.thinking).join("\n")
      } else if (textContent.length > 0) {
        assistantMsg.content = textContent
      }

      const toolCalls = msg.content.filter((p): p is ToolCall => p.type === "toolCall")
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }))
      }

      // Skip empty assistant messages
      const hasContent =
        (typeof assistantMsg.content === "string" && assistantMsg.content.length > 0) ||
        (Array.isArray(assistantMsg.content) && assistantMsg.content.length > 0)
      if (!hasContent && !assistantMsg.tool_calls) continue

      params.push(assistantMsg)
    } else if (msg.role === "toolResult") {
      const textResult = msg.content
        .filter((p): p is TextContent => p.type === "text")
        .map((p) => p.text)
        .join("\n")
      params.push({
        role: "tool",
        content: textResult || "(empty result)",
        tool_call_id: msg.toolCallId,
      })

      // If the tool result has images, send them as a follow-up user message
      const imageBlocks = msg.content.filter((p): p is ImageContent => p.type === "image")
      if (imageBlocks.length > 0 && model.input.includes("image")) {
        const imageContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = imageBlocks.map((block) => ({
          type: "image_url",
          image_url: { url: `data:${block.mimeType};base64,${block.data}` },
        }))
        params.push({ role: "user", content: imageContent })
      }
    }
  }

  return params
}

/** Convert our Tool definitions to OpenAI tool format. */
function convertTools(tools: Tool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as any,
      strict: false,
    },
  }))
}

/** Parse OpenAI usage response into our Usage type. */
function parseUsage(rawUsage: OpenAI.Completions.CompletionUsage | undefined, model: Model): Usage {
  if (!rawUsage) {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
  }

  const promptTokens = rawUsage.prompt_tokens || 0
  const promptDetails = rawUsage.prompt_tokens_details as { cached_tokens?: number; cache_write_tokens?: number } | undefined
  const cacheReadTokens = promptDetails?.cached_tokens ?? 0
  const cacheWriteTokens = promptDetails?.cache_write_tokens ?? 0
  const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens)
  const outputTokens = rawUsage.completion_tokens || 0

  return {
    input,
    output: outputTokens,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
    cost: {
      input: (input * model.cost.input) / 1_000_000,
      output: (outputTokens * model.cost.output) / 1_000_000,
      cacheRead: (cacheReadTokens * model.cost.cacheRead) / 1_000_000,
      cacheWrite: (cacheWriteTokens * model.cost.cacheWrite) / 1_000_000,
      total: 0,
    },
  }
}

/** Map OpenAI finish_reason to our StopReason. */
function mapStopReason(reason: string | null): { stopReason: StopReason; errorMessage?: string } {
  if (reason === null) return { stopReason: "stop" }
  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" }
    case "length":
      return { stopReason: "length" }
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" }
    case "content_filter":
      return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" }
    case "network_error":
      return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" }
    default:
      return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason}` }
  }
}

/** Build the OpenAI completion params from our model, context, and options. */
function buildParams(
  model: Model,
  context: Context,
  options?: OpenAICompletionsOptions,
  stream: boolean = false,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming | OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const messages = convertMessages(context, model)

  const params: any = {
    model: model.id,
    messages,
    stream,
  }

  if (stream) {
    params.stream_options = { include_usage: true }
  }

  if (options?.maxTokens) {
    params.max_completion_tokens = options.maxTokens
  }

  if (options?.temperature !== undefined) {
    params.temperature = options.temperature
  }

  if (context.tools && context.tools.length > 0) {
    params.tools = convertTools(context.tools)
  } else {
    // Some providers require tools param when conversation has tool history
    const hasToolHistory = context.messages.some(
      (m) => m.role === "assistant" && m.content.some((p) => p.type === "toolCall"),
    )
    if (hasToolHistory) {
      params.tools = []
    }
  }

  if (options?.toolChoice) {
    params.tool_choice = options.toolChoice
  }

  // Reasoning effort
  if (options?.reasoningEffort && model.reasoning) {
    params.reasoning_effort = options.reasoningEffort
  }

  return params as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
}

/** Extract assistant message content from a non-streaming OpenAI response. */
function extractAssistantMessage(
  response: OpenAI.Chat.Completions.ChatCompletion,
  model: Model,
): AssistantMessage {
  const choice = response.choices[0]
  if (!choice) {
    throw new Error("No choices in API response")
  }

  const content: (TextContent | ThinkingContent | ToolCall)[] = []

  // Extract text content
  const text = choice.message.content
  if (text && text.length > 0) {
    content.push({ type: "text", text })
  }

  // Extract reasoning/thinking content
  const reasoningContent =
    (choice.message as any).reasoning_content ??
    (choice.message as any).reasoning ??
    (choice.message as any).reasoning_text
  if (typeof reasoningContent === "string" && reasoningContent.length > 0) {
    content.push({ type: "thinking", thinking: reasoningContent })
  }

  // Extract tool calls
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      if (tc.type !== "function") continue
      content.push({
        type: "toolCall",
        id: tc.id,
        name: tc.function.name,
        arguments: parseStreamingJson(tc.function.arguments),
      })
    }
  }

  const { stopReason, errorMessage } = mapStopReason(choice.finish_reason)

  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: model.provider,
    model: model.id,
    responseModel: response.model,
    responseId: response.id,
    usage: parseUsage(response.usage, model),
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  }
}

// ── Public API: stream ─────────────────────────────────────────────────────────

/**
 * Stream a completion from an OpenAI-compatible endpoint.
 *
 * Yields AssistantMessageEvent events (text_delta, thinking_delta, etc.)
 * and provides a .result() method for the final AssistantMessage.
 */
export function stream(
  model: Model,
  context: Context,
  options?: OpenAICompletionsOptions,
): AssistantMessageEventStream {
  const eventStream = new AssistantMessageEventStream()

  ;(async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    }

    try {
      const apiKey = options?.apiKey || ""
      const client = createClient(model, apiKey, options)
      const params = buildParams(model, context, options, true) as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming

      const requestOptions: OpenAI.RequestOptions = {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        maxRetries: options?.maxRetries ?? 0,
      }

      const openaiStream = await client.chat.completions.create(params, requestOptions)

      eventStream.push({ type: "start", partial: output })

      let textBlock: TextContent | null = null
      let thinkingBlock: ThinkingContent | null = null
      let hasFinishReason = false
      let errorMessage: string | undefined

      // Track tool call blocks during streaming
      const toolCallBlocks: Map<number, ToolCall & { partialArgs?: string }> = new Map()

      for await (const chunk of openaiStream) {
        const choice = chunk.choices?.[0]
        if (!choice) {
          // Usage-only chunk (final chunk in some providers)
          if (chunk.usage) {
            output.usage = parseUsage(chunk.usage, model)
          }
          continue
        }

        if (choice.finish_reason) {
          const mapped = mapStopReason(choice.finish_reason)
          output.stopReason = mapped.stopReason
          if (mapped.errorMessage) {
            errorMessage = mapped.errorMessage
          }
          hasFinishReason = true
        }

        if (choice.delta) {
          // Text content
          if (choice.delta.content && choice.delta.content.length > 0) {
            if (!textBlock) {
              textBlock = { type: "text", text: "" }
              output.content.push(textBlock)
              eventStream.push({
                type: "text_start",
                contentIndex: output.content.length - 1,
                partial: output,
              })
            }
            textBlock.text += choice.delta.content
            eventStream.push({
              type: "text_delta",
              contentIndex: output.content.indexOf(textBlock),
              delta: choice.delta.content,
              partial: output,
            })
          }

          // Reasoning/thinking content (various field names across providers)
          const deltaFields = choice.delta as Record<string, unknown>
          const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"]
          for (const field of reasoningFields) {
            const value = deltaFields[field]
            if (typeof value === "string" && value.length > 0) {
              if (!thinkingBlock) {
                thinkingBlock = { type: "thinking", thinking: "", thinkingSignature: field }
                output.content.push(thinkingBlock)
                eventStream.push({
                  type: "thinking_start",
                  contentIndex: output.content.length - 1,
                  partial: output,
                })
              }
              thinkingBlock.thinking += value
              eventStream.push({
                type: "thinking_delta",
                contentIndex: output.content.indexOf(thinkingBlock),
                delta: value,
                partial: output,
              })
              break // Only use first matching field to avoid duplication
            }
          }

          // Tool calls
          if (choice.delta.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index ?? 0
              let block = toolCallBlocks.get(idx)
              if (!block) {
                block = {
                  type: "toolCall",
                  id: tc.id ?? "",
                  name: tc.function?.name ?? "",
                  arguments: {},
                  partialArgs: "",
                }
                toolCallBlocks.set(idx, block)
                output.content.push(block)
                eventStream.push({
                  type: "toolcall_start",
                  contentIndex: output.content.length - 1,
                  partial: output,
                })
              }
              if (tc.id && !block.id) block.id = tc.id
              if (tc.function?.name && !block.name) block.name = tc.function.name

              let delta = ""
              if (tc.function?.arguments) {
                delta = tc.function.arguments
                block.partialArgs = (block.partialArgs ?? "") + tc.function.arguments
                block.arguments = parseStreamingJson(block.partialArgs)
              }
              eventStream.push({
                type: "toolcall_delta",
                contentIndex: output.content.indexOf(block),
                delta,
                partial: output,
              })
            }
          }
        }

        // Usage in streaming chunks
        if (chunk.usage) {
          output.usage = parseUsage(chunk.usage, model)
        }
      }

      // Finalize text block
      if (textBlock) {
        eventStream.push({
          type: "text_end",
          contentIndex: output.content.indexOf(textBlock),
          content: textBlock.text,
          partial: output,
        })
      }

      // Finalize thinking block
      if (thinkingBlock) {
        eventStream.push({
          type: "thinking_end",
          contentIndex: output.content.indexOf(thinkingBlock),
          content: thinkingBlock.thinking,
          partial: output,
        })
      }

      // Finalize tool call blocks
      for (const [, block] of toolCallBlocks) {
        delete (block as any).partialArgs
        eventStream.push({
          type: "toolcall_end",
          contentIndex: output.content.indexOf(block),
          toolCall: block,
          partial: output,
        })
      }

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted")
      }

      if (output.stopReason === "aborted") {
        throw new Error("Request was aborted")
      }
      if (output.stopReason === "error") {
        throw new Error(errorMessage || output.errorMessage || "Provider returned an error stop reason")
      }
      if (!hasFinishReason) {
        throw new Error("Stream ended without finish_reason")
      }

      eventStream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output })
      eventStream.end()
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error"
      output.errorMessage = error instanceof Error ? error.message : String(error)
      // Some providers via OpenRouter give additional information in this field
      const rawMetadata = (error as any)?.error?.metadata?.raw
      if (rawMetadata) output.errorMessage += `\n${rawMetadata}`
      eventStream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output })
      eventStream.end()
    }
  })()

  return eventStream
}

// ── Public API: complete ───────────────────────────────────────────────────────

/**
 * Get a non-streaming completion from an OpenAI-compatible endpoint.
 * Returns the final AssistantMessage directly.
 */
export async function complete(
  model: Model,
  context: Context,
  options?: OpenAICompletionsOptions,
): Promise<AssistantMessage> {
  const apiKey = options?.apiKey || ""
  const client = createClient(model, apiKey, options)
  const params = buildParams(model, context, options, false) as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming

  const requestOptions: OpenAI.RequestOptions = {
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    maxRetries: options?.maxRetries ?? 0,
  }

  const response = await client.chat.completions.create(params, requestOptions)
  return extractAssistantMessage(response, model)
}
