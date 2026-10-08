import type { Plugin } from "@nano/plugins"
import { CONTROL_LOCAL_AGENTS, CONTROL_STORE } from "@nano/control-api"
import { assertNoDuplicateBridgePorts, assertNoDuplicateDiscordTokens, loadAgentFiles, resolveLocalAgents } from "./local-agents.js"
import type { ResolvedLocalAgent } from "@nano/control-api"
export { assertNoDuplicateBridgePorts, assertNoDuplicateDiscordTokens, effectiveRuntimeConfig, loadAgentFiles, parseAgentFile, resolveLocalAgents } from "./local-agents.js"
export type { AgentFile, ResolvedLocalAgent } from "@nano/control-api"

export function controlDiscoveryPlugin(options: { directory: string; controlPort: number; repoRoot: string; allowEmpty?: boolean }): Plugin.Object<unknown> {
  return {
    name: "control.discovery",
    inject: [CONTROL_STORE.name],
    provide: [CONTROL_LOCAL_AGENTS.name],
    apply(ctx) {
      let agents: ResolvedLocalAgent[]
      try {
        agents = resolveLocalAgents(loadAgentFiles(options.directory), options)
      } catch (error) {
        if (!options.allowEmpty || !(error instanceof Error) || !/agent directory does not exist|no agent JSON files found/.test(error.message)) throw error
        agents = []
      }
      assertNoDuplicateDiscordTokens(agents)
      assertNoDuplicateBridgePorts(agents, options.controlPort)
      ctx.provide(CONTROL_LOCAL_AGENTS.name, agents)
    },
  }
}
