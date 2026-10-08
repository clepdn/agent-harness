import type { Plugin } from "@nano/plugins"
import { createAgentChannelService, type AgentMailbox } from "../runner/agent-channel"
import type { RuntimeKind } from "../runner/types"
import { nano, type AgentChannelService } from "./api"

export const agentChannelPlugin: Plugin = {
  id: "nano.agent-channel",
  requires: [nano.persistence],
  provides: [nano.agentChannel],
  apply(scope) {
    const persistence = scope.use(nano.persistence)
    const mailbox: AgentMailbox = createAgentChannelService(
      persistence.getDb(),
      async (runtimeKind, event) => {
        const delivery = scope.list(nano.runtimeDelivery).find((entry) => entry.value.runtimeKind === runtimeKind)?.value
        if (!delivery) return false
        return await delivery.deliver(event)
      },
    )
    const service: AgentChannelService = {
      sendAgentChannelMessage: scope.guard((sender, content) => mailbox.sendAgentChannelMessage(sender, content)),
      listAgentChannelMessages: scope.guard((params) => mailbox.listAgentChannelMessages(params)),
    }
    const removeService = scope.provide(nano.agentChannel, service)
    const removeReady = scope.on(nano.runtimeReady, (runtimeKind: RuntimeKind) => mailbox.runtimeReady(runtimeKind))
    return () => {
      removeReady()
      return removeService()
    }
  },
}
