import type { RuntimeKind } from "./runner"

export interface ToolFilteringPolicy {
  readonly runtimeKind?: RuntimeKind
  readonly vision?: boolean
  readonly computerUse?: boolean
  readonly imageRoot?: string
}
