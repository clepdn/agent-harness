import type { Model } from "./llm"

// Process-local, like runtime model swaps. Applies to subsequent requests.
let enabled = false

export function getCodexFastMode(): boolean {
  return enabled
}

export function setCodexFastMode(value: boolean = !enabled): boolean {
  enabled = value
  return enabled
}

export function codexServiceTier(model: Pick<Model, "id" | "provider">): "priority" | "default" | undefined {
  // Codex model IDs and aliases, including presets using an OpenAI-compatible
  // endpoint, plus models explicitly configured with a Codex provider.
  const isCodex = ["codex", "openai-codex"].includes(model.provider.toLowerCase())
    || /^(?:gpt-|o3-|o4-|codex(?:-|$))/i.test(model.id)
  return isCodex ? (enabled ? "priority" : "default") : undefined
}
