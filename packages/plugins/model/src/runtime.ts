export {
  buildModel,
  isLikelyLocalBase,
  MODEL_PROVIDER,
  MODEL,
  MODEL_BASE_URL,
  PRIMARY_VISION,
  PRIMARY_NUDGE_ON_NO_TOOL,
  FALLBACK_PROVIDER,
  FALLBACK_MODEL,
  FALLBACK_N_CTX,
  FALLBACK_CONTEXT_MARGIN,
  FALLBACK_HARD_OVERFLOW_TOKENS,
  FALLBACK_ENFORCE_CONTEXT_LIMIT,
  SUMMARY_PROVIDER,
  SUMMARY_MODEL,
  PRIMARY_TOOL_CHOICE,
  FALLBACK_TOOL_CHOICE,
  ENABLE_THINKING,
  THINKING_EFFORT,
} from "./settings"
export type { CompactionStrategy, ThinkingEffort, ToolChoice } from "./settings"
export { createModelStateFactory } from "./runner/model-state"
export type { ModelStateFactoryOptions, ModelStateResource } from "./runner/model-state"
export type { ModelSwapSelection, RuntimeModelConfig } from "@nano/runtime-api/contracts/model"
