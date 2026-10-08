import type { TSchema } from "@nano/runtime-api/llm"
import type { ToolDefinition } from "@nano/harness-core"
import { config } from "@nano/runtime-api/config"
import { imageRootForModelInput } from "@nano/plugin-images/config"
import type { ToolFilteringPolicy } from "@nano/runtime-api/contracts/tools"
export type { ToolFilteringPolicy } from "@nano/runtime-api/contracts/tools"
import type { RuntimeKind } from "@nano/runtime-api/contracts/runner"


function normalizePolicy(policy: ToolFilteringPolicy | RuntimeKind = "main"): Required<ToolFilteringPolicy> {
  if (typeof policy === "string") return { runtimeKind: policy, vision: true, computerUse: config.computer_use.enabled, imageRoot: imageRootForModelInput() }
  return {
    runtimeKind: policy.runtimeKind ?? "main",
    vision: policy.vision ?? true,
    computerUse: policy.computerUse ?? config.computer_use.enabled,
    imageRoot: policy.imageRoot ?? imageRootForModelInput(),
  }
}

const SUBAGENT_AUTO_BLACKLIST = new Set([
  "wait", "end_session", "wait_then_continue", "subagent", "job_list", "job_status", "job_stdout", "job_cancel",
])

export function isToolEnabled(name: string, policy: ToolFilteringPolicy | RuntimeKind = "main"): boolean {
  const resolved = normalizePolicy(policy)
  const { enabled_tools, blacklisted_tools } = config.tools
  if (name === "image_tool" && !resolved.vision) return false
  if (name === "computer" && !resolved.computerUse) return false
  return (enabled_tools.length === 0 || enabled_tools.includes(name)) && !blacklisted_tools.includes(name)
}

export function isToolEnabledForSubagent(name: string, enabledTools: string[], blacklistedTools: string[]): boolean {
  if (SUBAGENT_AUTO_BLACKLIST.has(name)) return false
  return (enabledTools.length === 0 || enabledTools.includes(name)) && !blacklistedTools.includes(name)
}

export function getSubagentTools(
  definitions: readonly ToolDefinition[],
  enabledTools: string[],
  blacklistedTools: string[],
  policy: ToolFilteringPolicy = {},
): ToolDefinition[] {
  const root = normalizePolicy(policy).imageRoot
  return definitions.filter((tool) => isToolEnabledForSubagent(tool.function.name, enabledTools, blacklistedTools)).map((tool) =>
    tool.function.description.includes("{{IMAGE_ROOT}}")
      ? { ...tool, function: { ...tool.function, description: tool.function.description.replaceAll("{{IMAGE_ROOT}}", root) } }
      : tool,
  )
}

export function getCompletionTools(toolDefinitions: readonly ToolDefinition[], policy: ToolFilteringPolicy | RuntimeKind = "main"): Array<{ name: string; description: string; parameters: TSchema }> {
  const resolved = normalizePolicy(policy)
  return toolDefinitions
    .filter((tool) => isToolEnabled(tool.function.name, resolved))
    .map((tool) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters as TSchema }))
}
