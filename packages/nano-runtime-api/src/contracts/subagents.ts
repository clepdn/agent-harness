import type { SubagentConfig } from "../config"
import type { RuntimeKind } from "./runner"

export interface SubagentService {
  findSubagent(name: string): SubagentConfig | undefined
  runSubagent(convId: number, subagent: SubagentConfig, task: string, signal?: AbortSignal, runtimeKind?: RuntimeKind): Promise<string>
}
