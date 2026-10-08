import type { RuntimeModelConfig } from "@nano/runtime-api/contracts/model"
import type { LoopState } from "@nano/runtime-api/contracts/runner"

export function executionModel(state: Pick<LoopState, "runtimeKind" | "services">): RuntimeModelConfig {
  const model = state.services?.model
  if (!model) throw new Error("Runtime model service is unavailable")
  return model.current(state.runtimeKind)
}
