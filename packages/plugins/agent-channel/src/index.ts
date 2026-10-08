import type { Plugin } from "@nano/plugins"
import { createAgentChannelService } from "./agent-channel"
import type { RuntimeKind } from "@nano/runtime-api/contracts/runner"
import { getService, listContributions, nano, onEvent } from "@nano/runtime-api"
import type { AgentChannelService, AgentMailbox } from "@nano/runtime-api/contracts/agent-channel"
export const agentChannelPlugin: Plugin = {
  name: "nano.agent-channel",
  inject: [nano.persistence.name, "nano.contributions"],
  provide: nano.agentChannel.name,
  apply(ctx) {
    const persistence = getService(ctx, nano.persistence)
    const mailbox: AgentMailbox = createAgentChannelService(
      persistence.getDb(),
      async (runtimeKind, event) => {
        const delivery = listContributions(ctx, nano.runtimeDelivery).find((entry) => entry.value.runtimeKind === runtimeKind)?.value
        if (!delivery) return false
        return await delivery.deliver(event)
      },
    )
    const service: AgentChannelService = {
      sendAgentChannelMessage: (sender, content) => mailbox.sendAgentChannelMessage(sender, content),
      listAgentChannelMessages: (params) => mailbox.listAgentChannelMessages(params),
    }
    ctx.provide(nano.agentChannel.name, service)
    onEvent(ctx, nano.runtimeReady, (runtimeKind: RuntimeKind) => mailbox.runtimeReady(runtimeKind))
  },
}
export { createAgentChannelService } from "./agent-channel"
