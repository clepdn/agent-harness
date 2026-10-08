import { getService, type Plugin } from "@nano/plugins"
import { CONTROL_AGENTS, CONTROL_LOCAL_AGENTS, CONTROL_STORE } from "@nano/control-api"
import { buildWorkerEnvironment } from "@nano/control-api/local-agents"
import { LocalAgentSupervisor } from "./supervisor.js"

export { LocalAgentSupervisor, matchesWorkerIdentity } from "./supervisor.js"

export function controlSupervisorPlugin(options: { repoRoot: string; workerEntry: string }): Plugin.Object<unknown> {
  return {
    name: "control.supervisor",
    inject: [CONTROL_STORE.name, CONTROL_LOCAL_AGENTS.name],
    provide: [CONTROL_AGENTS.name],
    async apply(ctx) {
      const store = getService(ctx, CONTROL_STORE)
      const localAgents = getService(ctx, CONTROL_LOCAL_AGENTS)
      const supervisors = new Map<string, LocalAgentSupervisor>()
      const configuredAgentIds = new Set(localAgents.map((agent) => agent.id))
      for (const agent of localAgents) {
        supervisors.set(agent.id, new LocalAgentSupervisor({
          agent,
          repoRoot: options.repoRoot,
          workerEntry: options.workerEntry,
          workerEnv: buildWorkerEnvironment(process.env, agent),
          onReady: (readyAgent) => store.upsertAgent({ id: readyAgent.id, name: readyAgent.name, baseUrl: `http://127.0.0.1:${readyAgent.port}` }),
        }))
      }
      ctx.provide(CONTROL_AGENTS.name, {
        configuredAgentIds,
        async stopLocalAgent(id: string) {
          const supervisor = supervisors.get(id)
          if (!supervisor) return false
          await supervisor.stop()
          return true
        },
      })
      ctx.effect(() => async () => {
        await Promise.all([...supervisors.values()].map((supervisor) => supervisor.stop()))
      })
      await Promise.all([...supervisors.values()].map((supervisor) => supervisor.start()))
    },
  }
}
