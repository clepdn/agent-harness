import { stream, getModels, getModel } from "@earendil-works/pi-ai"
import type { Context, Model, ProviderStreamOptions, AssistantMessageEvent } from "@earendil-works/pi-ai"
import type { BridgeModelConfig } from "./config"

/**
 * Build a pi-ai Model object from bridge config.
 * Tries the pi-ai registry first (for known providers like openrouter, openai, etc.),
 * falls back to a custom model with the provided baseUrl.
 */
export function buildModel(config: BridgeModelConfig): Model<"openai-completions"> {
  // Try registry first
  if (!config.baseUrl) {
    try {
      const registered = getModel(config.provider as any, config.id as any)
      if (registered) return registered as Model<"openai-completions">
    } catch {
      // Not in registry, fall through to custom
    }

    // Try getting baseUrl from registry
    const models = getModels(config.provider as any)
    if (models.length > 0) {
      const baseUrl = models[0]!.baseUrl
      return {
        id: config.id,
        name: config.id,
        api: "openai-completions" as const,
        provider: config.provider,
        baseUrl,
        reasoning: config.reasoning ?? true,
        input: ["text" as const, "image" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.contextWindow ?? 200_000,
        maxTokens: config.maxTokens ?? 8192,
      }
    }
  }

  // Custom model with explicit baseUrl
  return {
    id: config.id,
    name: config.id,
    api: "openai-completions" as const,
    provider: config.provider,
    baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
    reasoning: config.reasoning ?? true,
    input: ["text" as const, "image" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow ?? 200_000,
    maxTokens: config.maxTokens ?? 8192,
  }
}

/**
 * Stream a completion from pi-ai and yield events.
 */
export async function* streamCompletion(
  model: Model<"openai-completions">,
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
