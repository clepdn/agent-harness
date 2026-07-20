import { stream, getModels, getModel } from "@earendil-works/pi-ai/compat"
import type { Context, Model, ProviderStreamOptions, AssistantMessageEvent, Api } from "@earendil-works/pi-ai"
import type { BridgeModelConfig } from "./config"

type AnyModel = Model<Api>

/**
 * Build a pi-ai Model object from bridge config.
 * Tries the pi-ai registry first (for known providers like openrouter, openai, etc.),
 * falls back to a custom model with the provided baseUrl.
 *
 * When OAuth is configured (Anthropic subscription), uses api: "anthropic-messages"
 * so pi-ai's anthropic provider handles Claude Code identity headers, OAuth beta
 * headers, and Bearer auth automatically.
 */
export function buildModel(config: BridgeModelConfig): AnyModel {
  // Determine the API to use
  // OAuth tokens (sk-ant-oat) require the anthropic-messages provider
  const isAnthropicOAuth = Boolean(config.authPath)

  const api: Api = isAnthropicOAuth ? "anthropic-messages" : "openai-completions"
  const provider = isAnthropicOAuth ? "anthropic" : config.provider
  const baseUrl = isAnthropicOAuth
    ? config.baseUrl ?? "https://api.anthropic.com"
    : config.baseUrl

  // Try registry first (for known providers)
  if (!config.baseUrl && !isAnthropicOAuth) {
    try {
      const registered = getModel(config.provider as any, config.id as any)
      if (registered) return registered as AnyModel
    } catch {
      // Not in registry, fall through to custom
    }

    const models = getModels(config.provider as any)
    if (models.length > 0) {
      const registeredBaseUrl = models[0]!.baseUrl
      return {
        id: config.id,
        name: config.id,
        api: "openai-completions" as const,
        provider: config.provider,
        baseUrl: registeredBaseUrl,
        reasoning: config.reasoning ?? true,
        input: ["text" as const, "image" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.contextWindow ?? 200_000,
        maxTokens: config.maxTokens ?? 8192,
      } as AnyModel
    }
  }

  // Custom model
  return {
    id: config.id,
    name: config.id,
    api,
    provider,
    baseUrl: baseUrl ?? "https://api.openai.com/v1",
    reasoning: config.reasoning ?? true,
    input: ["text" as const, "image" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow ?? 200_000,
    maxTokens: config.maxTokens ?? 8192,
  } as AnyModel
}

/**
 * Stream a completion from pi-ai and yield events.
 */
export async function* streamCompletion(
  model: AnyModel,
  context: Context,
  options?: { apiKey?: string; temperature?: number; maxTokens?: number },
): AsyncIterable<AssistantMessageEvent> {
  const streamOpts: ProviderStreamOptions = {
    apiKey: options?.apiKey,
    temperature: options?.temperature,
    maxTokens: options?.maxTokens,
  }

  const eventStream = stream(model, context, streamOpts)

  for await (const event of eventStream as AsyncIterable<AssistantMessageEvent>) {
    yield event
  }
}
