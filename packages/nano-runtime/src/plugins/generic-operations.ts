import type { Plugin } from "@nano/plugins"
import {
  conversationCancel,
  conversationHistory,
  conversationSubmit,
  conversationSubscribe,
  modelComplete,
  modelList,
  modelStream,
  toJsonValue,
  toolsList,
  type AssistantContentText,
  type AssistantContentThinking,
  type AssistantContentToolCall,
  type AssistantOutput,
  type AssistantUsage,
  type ConversationEvent as ProtocolConversationEvent,
  type ConversationHistoryItem as ProtocolConversationHistoryItem,
  type JsonRecord,
  type JsonValue,
  type ModelDescriptor,
  type ModelStreamEvent,
  type ToolDefinition as ProtocolToolDefinition,
} from "@nano/protocol"
import { registerOperation, registerStream } from "@nano/protocol/rpc"
import { nano } from "./api"
import type {
  ConversationService,
  ModelService,
  ToolContribution,
} from "./api"
import type {
  AssistantMessage,
  CompletionContext,
  ContextEffortUpdate,
  ImageContent,
  Message,
  Model,
  OpenAICompletionsOptions,
  TextContent,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage as ModelUserMessage,
} from "../llm"
import type { ContextImageReference, ContextImageState, ContextImageAttachment } from "../context-images"
import type { RuntimeKind } from "../runner/types"
import type { UserMessage as ConversationUserMessage } from "../types"

/** Public conversation RPC bindings. Execution is delegated to the active conversation service. */
export const conversationOperationsPlugin: Plugin = {
  id: "nano.conversation-operations",
  requires: [nano.conversation],
  apply(scope) {
    const conversation = scope.use(nano.conversation)
    const remove = [
      registerOperation(scope, conversationSubmit, async (input, context) => {
        checkSignal(context.signal)
        const result = await conversation.submit({
          event: conversationUserMessage(input.event),
          ...(input.runtimeKind === undefined ? {} : { runtimeKind: input.runtimeKind }),
        })
        checkSignal(context.signal)
        return result
      }),
      registerOperation(scope, conversationHistory, async (input, context) => {
        checkSignal(context.signal)
        const result = await conversation.history(input)
        checkSignal(context.signal)
        return result.map(conversationHistoryItem)
      }),
      registerOperation(scope, conversationCancel, async (input, context) => {
        checkSignal(context.signal)
        await conversation.cancel(input)
        checkSignal(context.signal)
      }),
      registerStream(scope, conversationSubscribe, (input, context) => conversationEventStream(conversation, input, context.signal)),
    ]
    return () => disposeAll(remove)
  },
}

/** Public model listing/completion bindings. Provider dispatch stays inside ModelService. */
export const modelOperationsPlugin: Plugin = {
  id: "nano.model-operations",
  requires: [nano.model],
  optional: [nano.images],
  apply(scope) {
    const model = scope.use(nano.model)
    const images = scope.optional(nano.images)
    const remove = [
      registerOperation(scope, modelList, (_input, context) => {
        checkSignal(context.signal)
        return model.list().map(modelDescriptor)
      }),
      registerOperation(scope, modelComplete, async (input, context) => {
        checkSignal(context.signal)
        const current = modelFromDescriptor(input.model)
        const completionContext = decodeCompletionContext(input.context)
        const options = decodeModelOptions(input.options, images?.prepareMessages)
        const message = await model.complete(current, completionContext, { ...options, signal: context.signal })
        checkSignal(context.signal)
        return assistantOutput(message)
      }),
      registerStream(scope, modelStream, (input, context) => modelEventStream(
        model,
        modelFromDescriptor(input.model),
        decodeCompletionContext(input.context),
        decodeModelOptions(input.options, images?.prepareMessages),
        context.signal,
      )),
    ]
    return () => disposeAll(remove)
  },
}

/** Public tool catalog binding. Tool execution intentionally remains conversation-local. */
export const toolsListOperationsPlugin: Plugin = {
  id: "nano.tools-list-operations",
  requires: [nano.tools],
  apply(scope) {
    const tools = scope.use(nano.tools)
    const remove = [registerOperation(scope, toolsList, (input, context) => {
      checkSignal(context.signal)
      return tools.list(input.runtimeKind).map(toolDefinition)
    })]
    return () => disposeAll(remove)
  },
}

type OperationDisposer = () => void

function disposeAll(disposers: OperationDisposer[]): void {
  for (const dispose of disposers.reverse()) dispose()
}

function checkSignal(signal: AbortSignal): void {
  if (!signal.aborted) return
  const reason = signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled")
  throw Object.assign(reason, { code: "CANCELLED" })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) throw new TypeError(`${label} contains unsupported field "${key}"`)
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`)
  return value
}

function optionalString(value: Record<string, unknown>, key: string, label: string): string | undefined {
  if (value[key] === undefined) return undefined
  return stringValue(value[key], `${label}.${key}`)
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`)
  return value
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`)
  return value
}

function jsonRecord(value: unknown, label: string): JsonRecord {
  const json = toJsonValue(value)
  if (!isRecord(json)) throw new TypeError(`${label} must be a JSON object`)
  return json as JsonRecord
}
function conversationUserMessage(input: { source: string; triggeredAt: string; content: string; clientId?: string; raw: unknown }): ConversationUserMessage {
  const source = conversationSource(input.source)
  const event: ConversationUserMessage = {
    source,
    triggeredAt: stringValue(input.triggeredAt, "event.triggeredAt"),
    content: stringValue(input.content, "event.content"),
    raw: toJsonValue(input.raw),
  }
  if (input.clientId !== undefined) event.clientId = stringValue(input.clientId, "event.clientId")
  return event
}

function conversationSource(value: string): ConversationUserMessage["source"] {
  const sources: readonly ConversationUserMessage["source"][] = ["discord", "voice", "bsky", "webhook", "cron", "chat", "job", "boredom", "client", "agent", "system"]
  if (!sources.includes(value as ConversationUserMessage["source"])) throw new TypeError(`event.source is unsupported: ${value}`)
  return value as ConversationUserMessage["source"]
}

function conversationHistoryItem(value: ProtocolConversationHistoryItem): ProtocolConversationHistoryItem {
  if (!isRecord(value) || typeof value.role !== "string" || !("content" in value)) {
    throw new TypeError("conversation history item is invalid")
  }
  const json = toJsonValue(value)
  if (!isRecord(json)) throw new TypeError("conversation history item must be a JSON object")
  return json as ProtocolConversationHistoryItem
}

async function* conversationEventStream(
  conversation: ConversationService,
  input: { runtimeKind?: RuntimeKind; after?: number; sessionId?: string },
  signal: AbortSignal,
): AsyncIterable<ProtocolConversationEvent> {
  checkSignal(signal)
  const source = conversation.subscribe(input, signal)
  for await (const event of source) {
    checkSignal(signal)
    if (!isRecord(event) || !("event" in event)) throw new TypeError("conversation event is invalid")
    const json = toJsonValue(event)
    if (!isRecord(json)) throw new TypeError("conversation event must be a JSON object")
    yield json as unknown as ProtocolConversationEvent
  }
}

function modelDescriptor(model: Model): ModelDescriptor {
  const output: ModelDescriptor = {
    id: stringValue(model.id, "model.id"),
    name: stringValue(model.name, "model.name"),
    api: stringValue(model.api, "model.api"),
    provider: stringValue(model.provider, "model.provider"),
    baseUrl: stringValue(model.baseUrl, "model.baseUrl"),
    reasoning: booleanValue(model.reasoning, "model.reasoning"),
    input: [...model.input],
    cost: {
      input: finiteNumber(model.cost.input, "model.cost.input"),
      output: finiteNumber(model.cost.output, "model.cost.output"),
      cacheRead: finiteNumber(model.cost.cacheRead, "model.cost.cacheRead"),
      cacheWrite: finiteNumber(model.cost.cacheWrite, "model.cost.cacheWrite"),
    },
    contextWindow: finiteNumber(model.contextWindow, "model.contextWindow"),
    maxTokens: finiteNumber(model.maxTokens, "model.maxTokens"),
  }
  if (model.bridge !== undefined) output.bridge = booleanValue(model.bridge, "model.bridge")
  if (model.effortCapabilities) {
    output.effortCapabilities = {
      supportedEfforts: model.effortCapabilities.supportedEfforts.map((effort) => stringValue(effort, "model.effortCapabilities.supportedEfforts")),
      ...(model.effortCapabilities.defaultEffort === undefined ? {} : { defaultEffort: stringValue(model.effortCapabilities.defaultEffort, "model.effortCapabilities.defaultEffort") }),
      changeMode: model.effortCapabilities.changeMode,
    }
  }
  // Deliberately omit model.headers: a model descriptor is public and headers may
  // contain provider credentials. Remote callers cannot provide headers either.
  return output
}

function modelFromDescriptor(input: ModelDescriptor): Model {
  if (input.headers !== undefined && !isRecord(input.headers)) throw new TypeError("model.headers must be an object")
  const model: Model = {
    id: stringValue(input.id, "model.id"),
    name: stringValue(input.name, "model.name"),
    api: stringValue(input.api, "model.api"),
    provider: stringValue(input.provider, "model.provider"),
    baseUrl: stringValue(input.baseUrl, "model.baseUrl"),
    reasoning: booleanValue(input.reasoning, "model.reasoning"),
    input: input.input.map((kind) => {
      if (kind !== "text" && kind !== "image") throw new TypeError("model.input contains an unsupported value")
      return kind
    }),
    cost: {
      input: finiteNumber(input.cost.input, "model.cost.input"),
      output: finiteNumber(input.cost.output, "model.cost.output"),
      cacheRead: finiteNumber(input.cost.cacheRead, "model.cost.cacheRead"),
      cacheWrite: finiteNumber(input.cost.cacheWrite, "model.cost.cacheWrite"),
    },
    contextWindow: finiteNumber(input.contextWindow, "model.contextWindow"),
    maxTokens: finiteNumber(input.maxTokens, "model.maxTokens"),
  }
  if (input.bridge !== undefined) model.bridge = booleanValue(input.bridge, "model.bridge")
  if (input.headers !== undefined) {
    if (!isRecord(input.headers)) throw new TypeError("model.headers must be an object")
    model.headers = Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [key, stringValue(value, `model.headers.${key}`)]))
  }
  if (input.effortCapabilities) {
    model.effortCapabilities = {
      supportedEfforts: input.effortCapabilities.supportedEfforts.map((effort) => stringValue(effort, "model.effortCapabilities.supportedEfforts")),
      ...(input.effortCapabilities.defaultEffort === undefined ? {} : { defaultEffort: stringValue(input.effortCapabilities.defaultEffort, "model.effortCapabilities.defaultEffort") }),
      changeMode: input.effortCapabilities.changeMode,
    }
  }
  return model
}

const MODEL_OPTION_KEYS = ["includeContextImages", "temperature", "maxTokens", "timeoutMs", "maxRetries", "toolChoice", "reasoningEffort"] as const

type ModelOptionKey = (typeof MODEL_OPTION_KEYS)[number]

function decodeModelOptions(value: JsonValue | undefined, prepareMessages?: (messages: Message[]) => Promise<void>): OpenAICompletionsOptions {
  if (value === undefined) return prepareMessages ? { prepareMessages } : {}
  if (!isRecord(value)) throw new TypeError("model options must be a JSON object")
  assertKeys(value, MODEL_OPTION_KEYS, "model options")
  const options: OpenAICompletionsOptions = {}
  for (const key of MODEL_OPTION_KEYS) {
    if (!(key in value)) continue
    const item = value[key]
    switch (key satisfies ModelOptionKey) {
      case "includeContextImages": options.includeContextImages = booleanValue(item, `model options.${key}`); break
      case "temperature": options.temperature = finiteNumber(item, `model options.${key}`); break
      case "maxTokens": options.maxTokens = finiteNumber(item, `model options.${key}`); break
      case "timeoutMs": options.timeoutMs = finiteNumber(item, `model options.${key}`); break
      case "maxRetries": options.maxRetries = finiteNumber(item, `model options.${key}`); break
      case "reasoningEffort": options.reasoningEffort = stringValue(item, `model options.${key}`); break
      case "toolChoice": options.toolChoice = decodeToolChoice(item); break
    }
  }
  if (prepareMessages) options.prepareMessages = prepareMessages
  return options
}

function decodeToolChoice(value: unknown): OpenAICompletionsOptions["toolChoice"] {
  if (value === "auto" || value === "none" || value === "required") return value
  if (!isRecord(value)) throw new TypeError("model options.toolChoice is invalid")
  assertKeys(value, ["type", "function"], "model options.toolChoice")
  if (value.type !== "function" || !isRecord(value.function)) throw new TypeError("model options.toolChoice is invalid")
  assertKeys(value.function, ["name"], "model options.toolChoice.function")
  return { type: "function", function: { name: stringValue(value.function.name, "model options.toolChoice.function.name") } }
}

function decodeCompletionContext(value: JsonValue): CompletionContext {
  if (!isRecord(value)) throw new TypeError("completion context must be a JSON object")
  assertKeys(value, ["systemPrompt", "messages", "tools", "effortUpdates"], "completion context")
  const messages = value.messages
  if (!Array.isArray(messages)) throw new TypeError("completion context.messages must be an array")
  const output: CompletionContext = { messages: messages.map((message, index) => decodeMessage(message, `completion context.messages[${index}]`)) }
  if (value.systemPrompt !== undefined) output.systemPrompt = stringValue(value.systemPrompt, "completion context.systemPrompt")
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools)) throw new TypeError("completion context.tools must be an array")
    output.tools = value.tools.map((tool, index) => decodeTool(tool, `completion context.tools[${index}]`))
  }
  if (value.effortUpdates !== undefined) {
    if (!Array.isArray(value.effortUpdates)) throw new TypeError("completion context.effortUpdates must be an array")
    output.effortUpdates = value.effortUpdates.map((update, index) => decodeEffortUpdate(update, `completion context.effortUpdates[${index}]`))
  }
  return output
}

function decodeEffortUpdate(value: unknown, label: string): ContextEffortUpdate {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  assertKeys(value, ["beforeMessageIndex", "effort"], label)
  const beforeMessageIndex = finiteNumber(value.beforeMessageIndex, `${label}.beforeMessageIndex`)
  if (!Number.isInteger(beforeMessageIndex) || beforeMessageIndex < 0) throw new TypeError(`${label}.beforeMessageIndex must be a non-negative integer`)
  return { beforeMessageIndex, effort: stringValue(value.effort, `${label}.effort`) }
}

function decodeTool(value: unknown, label: string): Tool {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  assertKeys(value, ["name", "description", "parameters"], label)
  return {
    name: stringValue(value.name, `${label}.name`),
    description: stringValue(value.description, `${label}.description`),
    parameters: jsonRecord(value.parameters, `${label}.parameters`),
  }
}

function decodeMessage(value: unknown, label: string): Message {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  const role = stringValue(value.role, `${label}.role`)
  if (role === "user") {
    assertKeys(value, ["role", "content", "timestamp", "imageReferences", "imageAttachments", "imageNotes", "imagesSuppressed"], label)
    return { role, content: decodeUserContent(value.content, `${label}.content`), timestamp: finiteNumber(value.timestamp, `${label}.timestamp`), ...decodeImageState(value, label) }
  }
  if (role === "assistant") {
    assertKeys(value, ["role", "content", "api", "provider", "model", "responseModel", "responseId", "usage", "stopReason", "errorMessage", "timestamp"], label)
    const message: AssistantMessage = {
      role,
      content: decodeAssistantContent(value.content, `${label}.content`),
      api: stringValue(value.api, `${label}.api`),
      provider: stringValue(value.provider, `${label}.provider`),
      model: stringValue(value.model, `${label}.model`),
      usage: decodeUsage(value.usage, `${label}.usage`),
      stopReason: decodeStopReason(value.stopReason, `${label}.stopReason`),
      timestamp: finiteNumber(value.timestamp, `${label}.timestamp`),
    }
    const responseModel = optionalString(value, "responseModel", label)
    const responseId = optionalString(value, "responseId", label)
    const errorMessage = optionalString(value, "errorMessage", label)
    if (responseModel !== undefined) message.responseModel = responseModel
    if (responseId !== undefined) message.responseId = responseId
    if (errorMessage !== undefined) message.errorMessage = errorMessage
    return message
  }
  if (role === "toolResult") {
    assertKeys(value, ["role", "toolCallId", "toolName", "content", "details", "isError", "timestamp", "imageReferences", "imageAttachments", "imageNotes", "imagesSuppressed"], label)
    const content = value.content
    if (!Array.isArray(content)) throw new TypeError(`${label}.content must be an array`)
    const message: ToolResultMessage = {
      role,
      toolCallId: stringValue(value.toolCallId, `${label}.toolCallId`),
      toolName: stringValue(value.toolName, `${label}.toolName`),
      content: content.map((part, index) => decodeImageOrText(part, `${label}.content[${index}]`)),
      isError: booleanValue(value.isError, `${label}.isError`),
      timestamp: finiteNumber(value.timestamp, `${label}.timestamp`),
      ...decodeImageState(value, label),
    }
    if (value.details !== undefined) message.details = toJsonValue(value.details)
    return message
  }
  throw new TypeError(`${label}.role is unsupported`)
}

function decodeUserContent(value: unknown, label: string): ModelUserMessage["content"] {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) throw new TypeError(`${label} must be a string or array`)
  return value.map((part, index) => decodeImageOrText(part, `${label}[${index}]`))
}

function decodeImageOrText(value: unknown, label: string): TextContent | ImageContent {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  if (value.type === "text") {
    assertKeys(value, ["type", "text", "textSignature"], label)
    const text: TextContent = { type: "text", text: stringValue(value.text, `${label}.text`) }
    if (value.textSignature !== undefined) text.textSignature = stringValue(value.textSignature, `${label}.textSignature`)
    return text
  }
  if (value.type === "image") {
    assertKeys(value, ["type", "data", "mimeType"], label)
    return { type: "image", data: stringValue(value.data, `${label}.data`), mimeType: stringValue(value.mimeType, `${label}.mimeType`) }
  }
  throw new TypeError(`${label}.type is unsupported`)
}

function decodeAssistantContent(value: unknown, label: string): AssistantMessage["content"] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  return value.map((part, index) => {
    if (!isRecord(part)) throw new TypeError(`${label}[${index}] must be an object`)
    if (part.type === "text") {
      assertKeys(part, ["type", "text", "textSignature"], `${label}[${index}]`)
      const text: AssistantContentText = { type: "text", text: stringValue(part.text, `${label}[${index}].text`) }
      if (part.textSignature !== undefined) text.textSignature = stringValue(part.textSignature, `${label}[${index}].textSignature`)
      return text
    }
    if (part.type === "thinking") {
      assertKeys(part, ["type", "thinking", "thinkingSignature", "redacted"], `${label}[${index}]`)
      const thinking: AssistantContentThinking = { type: "thinking", thinking: stringValue(part.thinking, `${label}[${index}].thinking`) }
      if (part.thinkingSignature !== undefined) thinking.thinkingSignature = stringValue(part.thinkingSignature, `${label}[${index}].thinkingSignature`)
      if (part.redacted !== undefined) thinking.redacted = booleanValue(part.redacted, `${label}[${index}].redacted`)
      return thinking
    }
    if (part.type === "toolCall") {
      assertKeys(part, ["type", "id", "name", "arguments", "thoughtSignature"], `${label}[${index}]`)
      const call: ToolCall = { type: "toolCall", id: stringValue(part.id, `${label}[${index}].id`), name: stringValue(part.name, `${label}[${index}].name`), arguments: jsonRecord(part.arguments, `${label}[${index}].arguments`) }
      if (part.thoughtSignature !== undefined) call.thoughtSignature = stringValue(part.thoughtSignature, `${label}[${index}].thoughtSignature`)
      return call
    }
    throw new TypeError(`${label}[${index}].type is unsupported`)
  })
}

function decodeImageState(value: Record<string, unknown>, label: string): ContextImageState {
  const output: ContextImageState = {}
  if (value.imageReferences !== undefined) {
    if (!Array.isArray(value.imageReferences)) throw new TypeError(`${label}.imageReferences must be an array`)
    output.imageReferences = value.imageReferences.map((reference, index) => decodeImageReference(reference, `${label}.imageReferences[${index}]`))
  }
  if (value.imageAttachments !== undefined) {
    if (!Array.isArray(value.imageAttachments)) throw new TypeError(`${label}.imageAttachments must be an array`)
    output.imageAttachments = value.imageAttachments.map((attachment, index) => decodeImageAttachment(attachment, `${label}.imageAttachments[${index}]`))
  }
  if (value.imageNotes !== undefined) {
    if (!Array.isArray(value.imageNotes)) throw new TypeError(`${label}.imageNotes must be an array`)
    output.imageNotes = value.imageNotes.map((note, index) => stringValue(note, `${label}.imageNotes[${index}]`))
  }
  if (value.imagesSuppressed !== undefined) output.imagesSuppressed = booleanValue(value.imagesSuppressed, `${label}.imagesSuppressed`)
  return output
}

function decodeImageReference(value: unknown, label: string): ContextImageReference {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  const kind = stringValue(value.kind, `${label}.kind`)
  if (kind === "markdown") {
    assertKeys(value, ["kind", "path", "label"], label)
    return { kind, path: stringValue(value.path, `${label}.path`), label: stringValue(value.label, `${label}.label`) }
  }
  if (kind === "discord-avatar") {
    assertKeys(value, ["kind", "userId", "label", "avatar", "discriminator", "own"], label)
    const output: Extract<ContextImageReference, { kind: "discord-avatar" }> = { kind, userId: stringValue(value.userId, `${label}.userId`), label: stringValue(value.label, `${label}.label`) }
    if (value.avatar !== undefined && value.avatar !== null) output.avatar = stringValue(value.avatar, `${label}.avatar`)
    if (value.discriminator !== undefined) output.discriminator = stringValue(value.discriminator, `${label}.discriminator`)
    if (value.own !== undefined) output.own = booleanValue(value.own, `${label}.own`)
    return output
  }
  if (kind === "discord-emoji") {
    assertKeys(value, ["kind", "emojiId", "name", "animated", "label"], label)
    return { kind, emojiId: stringValue(value.emojiId, `${label}.emojiId`), name: stringValue(value.name, `${label}.name`), animated: booleanValue(value.animated, `${label}.animated`), label: stringValue(value.label, `${label}.label`) }
  }
  throw new TypeError(`${label}.kind is unsupported`)
}

function decodeImageAttachment(value: unknown, label: string): ContextImageAttachment {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  assertKeys(value, ["type", "key", "label", "data", "mimeType"], label)
  if (value.type !== "image") throw new TypeError(`${label}.type must be image`)
  return { type: "image", key: stringValue(value.key, `${label}.key`), label: stringValue(value.label, `${label}.label`), data: stringValue(value.data, `${label}.data`), mimeType: stringValue(value.mimeType, `${label}.mimeType`) }
}

function decodeUsage(value: unknown, label: string): Usage {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  assertKeys(value, ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"], label)
  if (!isRecord(value.cost)) throw new TypeError(`${label}.cost must be an object`)
  assertKeys(value.cost, ["input", "output", "cacheRead", "cacheWrite", "total"], `${label}.cost`)
  return {
    input: finiteNumber(value.input, `${label}.input`),
    output: finiteNumber(value.output, `${label}.output`),
    cacheRead: finiteNumber(value.cacheRead, `${label}.cacheRead`),
    cacheWrite: finiteNumber(value.cacheWrite, `${label}.cacheWrite`),
    totalTokens: finiteNumber(value.totalTokens, `${label}.totalTokens`),
    cost: {
      input: finiteNumber(value.cost.input, `${label}.cost.input`),
      output: finiteNumber(value.cost.output, `${label}.cost.output`),
      cacheRead: finiteNumber(value.cost.cacheRead, `${label}.cost.cacheRead`),
      cacheWrite: finiteNumber(value.cost.cacheWrite, `${label}.cost.cacheWrite`),
      total: finiteNumber(value.cost.total, `${label}.cost.total`),
    },
  }
}

function decodeStopReason(value: unknown, label: string): AssistantMessage["stopReason"] {
  if (value !== "stop" && value !== "length" && value !== "toolUse" && value !== "error" && value !== "aborted") throw new TypeError(`${label} is unsupported`)
  return value
}

function assistantOutput(message: AssistantMessage): AssistantOutput {
  if (message.role !== "assistant") throw new TypeError("model completion did not return an assistant message")
  const content: AssistantOutput["content"] = message.content.map((part, index) => {
    if (part.type === "text") {
      const output: AssistantContentText = { type: "text", text: stringValue(part.text, `assistant.content[${index}].text`) }
      if (part.textSignature !== undefined) output.textSignature = stringValue(part.textSignature, `assistant.content[${index}].textSignature`)
      return output
    }
    if (part.type === "thinking") {
      const output: AssistantContentThinking = { type: "thinking", thinking: stringValue(part.thinking, `assistant.content[${index}].thinking`) }
      if (part.thinkingSignature !== undefined) output.thinkingSignature = stringValue(part.thinkingSignature, `assistant.content[${index}].thinkingSignature`)
      if (part.redacted !== undefined) output.redacted = booleanValue(part.redacted, `assistant.content[${index}].redacted`)
      return output
    }
    if (part.type === "toolCall") {
      const output: AssistantContentToolCall = { type: "toolCall", id: stringValue(part.id, `assistant.content[${index}].id`), name: stringValue(part.name, `assistant.content[${index}].name`), arguments: jsonRecord(part.arguments, `assistant.content[${index}].arguments`) }
      if (part.thoughtSignature !== undefined) output.thoughtSignature = stringValue(part.thoughtSignature, `assistant.content[${index}].thoughtSignature`)
      return output
    }
    throw new TypeError(`assistant.content[${index}] has an unsupported type`)
  })
  const output: AssistantOutput = {
    role: "assistant",
    content,
    api: stringValue(message.api, "assistant.api"),
    provider: stringValue(message.provider, "assistant.provider"),
    model: stringValue(message.model, "assistant.model"),
    usage: assistantUsage(message.usage),
    stopReason: decodeStopReason(message.stopReason, "assistant.stopReason"),
    timestamp: finiteNumber(message.timestamp, "assistant.timestamp"),
  }
  if (message.responseModel !== undefined) output.responseModel = stringValue(message.responseModel, "assistant.responseModel")
  if (message.responseId !== undefined) output.responseId = stringValue(message.responseId, "assistant.responseId")
  if (message.errorMessage !== undefined) output.errorMessage = stringValue(message.errorMessage, "assistant.errorMessage")
  return output
}

function assistantUsage(usage: Usage): AssistantUsage {
  return {
    input: finiteNumber(usage.input, "assistant.usage.input"),
    output: finiteNumber(usage.output, "assistant.usage.output"),
    cacheRead: finiteNumber(usage.cacheRead, "assistant.usage.cacheRead"),
    cacheWrite: finiteNumber(usage.cacheWrite, "assistant.usage.cacheWrite"),
    totalTokens: finiteNumber(usage.totalTokens, "assistant.usage.totalTokens"),
    cost: {
      input: finiteNumber(usage.cost.input, "assistant.usage.cost.input"),
      output: finiteNumber(usage.cost.output, "assistant.usage.cost.output"),
      cacheRead: finiteNumber(usage.cost.cacheRead, "assistant.usage.cost.cacheRead"),
      cacheWrite: finiteNumber(usage.cost.cacheWrite, "assistant.usage.cost.cacheWrite"),
      total: finiteNumber(usage.cost.total, "assistant.usage.cost.total"),
    },
  }
}

async function* modelEventStream(
  model: ModelService,
  current: Model,
  completionContext: CompletionContext,
  options: OpenAICompletionsOptions,
  signal: AbortSignal,
): AsyncIterable<ModelStreamEvent> {
  checkSignal(signal)
  const source = model.stream(current, completionContext, { ...options, signal })
  try {
    for await (const event of source) {
      checkSignal(signal)
      if (event.type === "text_delta") {
        yield { type: "text_delta", delta: stringValue(event.delta, "model stream text delta") }
      } else if (event.type === "thinking_delta") {
        yield { type: "thinking_delta", delta: stringValue(event.delta, "model stream thinking delta") }
      } else if (event.type === "toolcall_end") {
        const toolCall = event.toolCall
        yield {
          type: "tool_call",
          id: stringValue(toolCall.id, "model stream tool id"),
          name: stringValue(toolCall.name, "model stream tool name"),
          arguments: jsonRecord(toolCall.arguments, "model stream tool arguments"),
          ...(toolCall.thoughtSignature === undefined ? {} : { thoughtSignature: stringValue(toolCall.thoughtSignature, "model stream tool thoughtSignature") }),
        }
      } else if (event.type === "done") {
        yield { type: "done", message: assistantOutput(event.message) }
        return
      } else if (event.type === "error") {
        yield { type: "error", error: stringValue(event.error.errorMessage ?? "Model stream failed", "model stream error") }
        return
      }
    }
  } finally {
    if (signal.aborted) checkSignal(signal)
  }
}


function toolDefinition(contribution: ToolContribution): ProtocolToolDefinition {
  const definition = contribution.definition
  if (!definition || definition.type !== "function" || !definition.function) throw new TypeError("tool contribution has an invalid definition")
  const name = stringValue(definition.function.name, "tool definition name")
  const inputSchema = jsonRecord(definition.function.parameters, `tool ${name} parameters`)
  const description = definition.function.description
  return { name, inputSchema, ...(description === undefined ? {} : { description: stringValue(description, `tool ${name} description`) }) }
}
