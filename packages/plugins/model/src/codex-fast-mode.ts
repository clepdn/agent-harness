import type { Model } from "@nano/runtime-api/llm"

/** Resolve the OpenAI service tier from the model identity and scoped fast-mode state. */
export function codexServiceTier(
  model: Pick<Model, "id" | "provider">,
  enabled: boolean,
): "priority" | "default" | undefined {
  // Codex model IDs and aliases, including presets using an OpenAI-compatible
  // endpoint, plus models explicitly configured with a Codex provider.
  const isCodex = ["codex", "openai-codex"].includes(model.provider.toLowerCase())
    || /^(?:gpt-|o3-|o4-|codex(?:-|$))/i.test(model.id)
  return isCodex ? (enabled ? "priority" : "default") : undefined
}
