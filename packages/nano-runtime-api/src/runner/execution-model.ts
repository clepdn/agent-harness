import type { RuntimeModelConfig } from "./model-state"
import type { LoopState } from "./types"

export function executionModel(state: Pick<LoopState, "runtimeKind" | "services">): RuntimeModelConfig {
  const model = state.services?.model
  if (!model) throw new Error("Runtime model service is unavailable")
  return model.current(state.runtimeKind)
}
