import type { Plugin } from "@nano/plugins"
import { AGENT_ID } from "../agent-config"
import { config } from "../config"
import { fromBsky } from "../triggers/bsky"
import { fromChat } from "../triggers/chat"
import { fromCron } from "../triggers/cron"
import { fromDiscord } from "../triggers/discord"
import { fromWebhook } from "../triggers/webhook"
import { nano } from "./api"
import type { ConversationEvent, ConversationService, RunnerService, RuntimeExecutionServices } from "./api"
import { createRunnerRuntime } from "../runner/index"
import { createFrontendRunnerRuntime } from "../runner/frontend"
import type { WorkerEvent } from "@nano/protocol"

export function createRunnerPlugin(): Plugin {
  return {
    id: "nano.runner",
    requires: [nano.model, nano.persistence, nano.bootstrap],
    optional: [nano.memory, nano.discord, nano.metrics, nano.events, nano.contextManagement, nano.jobs, nano.tools, nano.client, nano.images, nano.subagents, nano.agentChannel, nano.webSearch],
    provides: [nano.runner, nano.conversation],
    async apply(scope) {
      const model = scope.use(nano.model)
      const persistence = scope.use(nano.persistence)
      const bootstrap = scope.use(nano.bootstrap)
      const services: RuntimeExecutionServices = {
        providerResolver: model.resolver(),
        model, persistence, bootstrap,
        memory: scope.optional(nano.memory),
        discord: scope.optional(nano.discord),
        metrics: scope.optional(nano.metrics),
        events: scope.optional(nano.events),
        contextManagement: scope.optional(nano.contextManagement),
        jobs: scope.optional(nano.jobs),
        tools: scope.optional(nano.tools),
        client: scope.optional(nano.client),
        images: scope.optional(nano.images),
        subagents: scope.optional(nano.subagents),
        agentChannel: scope.optional(nano.agentChannel),
        webSearch: scope.optional(nano.webSearch),
        strategies: () => scope.list(nano.strategies),
      }
      const frontend = createFrontendRunnerRuntime(services)
      scope.own(() => frontend.cleanup())
      const main = createRunnerRuntime(services, frontend)
      scope.own(() => main.cleanup())
      await bootstrap.ensureSoulFilePlacement()
      const frontendSoul = config.frontend.enable ? await bootstrap.reconcileFrontendSoul() : undefined
      if (frontendSoul?.requiresFreshSession) await persistence.clearSession("frontend")
      await main.recoverModelSwapHandoff()
      scope.signal.throwIfAborted()
      if (frontendSoul?.conflicted) {
        frontend.activateFrontend({
          source: "system", triggeredAt: new Date().toISOString(), raw: null,
          content: "[frontend soul merge conflict] Your virtual memory://soul.md contains unresolved merge markers after the main soul changed. Read memory://soul.md, reconcile the main and frontend versions, then edit the virtual soul to remove all markers. Your edits update the frontend patch; the main soul is unchanged.",
        })
      }
      const service: RunnerService = {
        activate: scope.guard((event) => main.activate(event)),
        wake: scope.guard((event) => main.wake(event)),
        enqueue: scope.guard((event, options) => main.enqueueEvent(event, options)),
        status: scope.guard(() => main.getRunnerStatus()),
        interrupt: scope.guard(() => main.requestInterrupt()),
        discard: scope.guard(() => main.requestDiscard()),
        rest: scope.guard((reason) => main.requestRest(reason)),
        compact: scope.guard((options) => main.requestCompaction(options)),
        swapModel: scope.guard((preset) => main.requestModelSwap(preset)),
        modelSnapshot: scope.guard(() => {
          const current = model.current("main")
          const primary = current.primaryModel
          const fallback = current.fallbackModel
          return {
            primary: primary ? { id: primary.id, provider: primary.provider, baseUrl: primary.baseUrl } : null,
            fallback: { id: fallback.id, provider: fallback.provider, baseUrl: fallback.baseUrl },
            respectPromptCache: current.respectPromptCache,
            useFallback: current.useFallback,
            enableThinking: current.enableThinking,
            thinkingEffort: current.thinkingEffort,
            vision: current.primaryVision,
          }
        }),
        trigger: scope.guard(async (source, body, signal) => {
          signal?.throwIfAborted()
          const event = source === "discord" ? fromDiscord(body)
            : source === "bsky" ? fromBsky(body)
              : source === "webhook" ? fromWebhook(body)
                : source === "cron" ? fromCron()
                  : fromChat(body)
          main.activate(event)
          return { ok: true, agentId: AGENT_ID, running: main.getRunnerStatus().running }
        }),
      }
      const conversation: ConversationService = {
        submit: scope.guard(async ({ event, runtimeKind }) => {
          if (runtimeKind === "frontend") frontend.activateFrontend(event)
          else main.activate(event)
          return { accepted: true, running: runtimeKind === "frontend" ? frontend.getFrontendRunnerStatus().running : main.getRunnerStatus().running }
        }),
        history: scope.guard((input) => persistence.history(input)),
        subscribe: scope.guard((input, signal) => {
          const controller = new AbortController()
          const combined = AbortSignal.any([scope.signal, controller.signal, ...(signal ? [signal] : [])])
          const iterator = conversationEvents(input, combined)
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => iterator.next(),
              return: async () => { controller.abort(); return iterator.return(undefined) },
              throw: async (error?: unknown) => { controller.abort(); return iterator.throw(error) },
            }),
          }
        }),
        cancel: scope.guard(async ({ runtimeKind }) => {
          if (runtimeKind === "frontend") frontend.requestInterrupt()
          else main.requestInterrupt()
        }),
      }
      async function* conversationEvents(input: Parameters<ConversationService["subscribe"]>[0], signal: AbortSignal): AsyncGenerator<ConversationEvent> {
        const queue: ConversationEvent[] = []
        let wake: (() => void) | undefined
        let cursor = input.after ?? 0
        const accept = (event: WorkerEvent): void => {
          if (!event.type.startsWith("conversation.")) return
          if (!event.payload || typeof event.payload !== "object" || !("conversationId" in event.payload) || typeof event.payload.conversationId !== "number") return
          const conversationId = event.payload.conversationId
          if (input.sessionId !== undefined && String(conversationId) !== input.sessionId) return
          const row = persistence.getDb().prepare<unknown[], { source: string }>("select source from conversations where id = ?").get(conversationId)
          if (!row || row.source.startsWith("frontend:") !== (input.runtimeKind === "frontend")) return
          if (event.seq > 0) {
            if (event.seq <= cursor) return
            cursor = event.seq
          }
          queue.push({ seq: event.seq, event })
          wake?.()
          wake = undefined
        }
        const abort = (): void => { wake?.(); wake = undefined }
        signal.addEventListener("abort", abort, { once: true })
        const remove = persistence.subscribeWorkerEvents(accept)
        try {
          for (const event of persistence.listWorkerEvents(cursor, 10_000, "after")) accept(event)
          while (!signal.aborted) {
            if (queue.length) yield queue.shift()!
            else await new Promise<void>((resolve) => { wake = resolve; if (signal.aborted) abort() })
          }
        } finally {
          remove()
          signal.removeEventListener("abort", abort)
        }
      }
      scope.on(nano.wake, ({ runtimeKind, event, priority }) => {
        if (runtimeKind === "frontend") frontend.activateFrontend(event, { priority })
        else main.activate(event, { priority })
      })
      scope.provide(nano.runner, service)
      scope.provide(nano.conversation, conversation)
      scope.register(nano.runtimeDelivery, "main", {
        runtimeKind: "main",
        deliver: scope.guard((event) => { main.activate(event); return true }),
        waiting: scope.guard(() => main.getRunnerStatus().idle),
        enqueue: scope.guard((event, options) => main.enqueueEvent(event, options)),
      })
      if (config.frontend.enable) scope.register(nano.runtimeDelivery, "frontend", {
        runtimeKind: "frontend",
        deliver: scope.guard((event) => { frontend.activateFrontend(event); return true }),
        waiting: scope.guard(() => frontend.getFrontendRunnerStatus().idle),
        enqueue: scope.guard((event: Parameters<typeof frontend.enqueueFrontendEvent>[0], options?: { onlyIfWaiting?: boolean; priority?: boolean }) => {
          if (options?.onlyIfWaiting && !frontend.getFrontendRunnerStatus().idle) return false
          return frontend.enqueueFrontendEvent(event, options)
        }),
      })
      scope.timeout(async () => {
        main.startBoredomTimer()
        frontend.startFrontendBoredomTimer()
        await scope.emit(nano.runtimeReady, "main")
        if (config.frontend.enable) await scope.emit(nano.runtimeReady, "frontend")
      }, 0)
    },
  }
}

export const runnerPlugin = createRunnerPlugin()
