import type { Plugin } from "@nano/plugins"
import { AGENT_ID } from "@nano/runtime-api/agent-config"
import { config } from "@nano/runtime-api/config"
import { fromBsky } from "@nano/runtime-api/triggers/bsky"
import { fromChat } from "@nano/runtime-api/triggers/chat"
import { fromCron } from "@nano/runtime-api/triggers/cron"
import { fromDiscord } from "@nano/runtime-api/triggers/discord"
import { fromWebhook } from "@nano/runtime-api/triggers/webhook"
import { emitEvent, findService, getService, listContributions, nano, onEvent, registerContribution } from "@nano/runtime-api"
import type { ConversationEvent, ConversationService, RunnerService, RuntimeExecutionServices } from "@nano/runtime-api"
import { createRunnerRuntime } from "@nano/runtime-api/runner"
import { createFrontendRunnerRuntime } from "@nano/runtime-api/runner/frontend"
import type { WorkerEvent } from "@nano/protocol"

export function createRunnerPlugin(): Plugin {
  return {
    name: "nano.runner",
    inject: [nano.model.name, nano.persistence.name, nano.bootstrap.name, "nano.contributions"],
    provide: [nano.runner.name, nano.conversation.name],
    async apply(ctx) {
      const model = getService(ctx, nano.model)
      const persistence = getService(ctx, nano.persistence)
      const bootstrap = getService(ctx, nano.bootstrap)
      const services: RuntimeExecutionServices = {
        providerResolver: model.resolver(),
        model,
        persistence,
        bootstrap,
        get memory() { return findService(ctx, nano.memory) },
        get discord() { return findService(ctx, nano.discord) },
        get metrics() { return findService(ctx, nano.metrics) },
        get events() { return findService(ctx, nano.events) },
        get contextManagement() { return findService(ctx, nano.contextManagement) },
        get jobs() { return findService(ctx, nano.jobs) },
        get tools() { return findService(ctx, nano.tools) },
        get client() { return findService(ctx, nano.client) },
        get images() { return findService(ctx, nano.images) },
        get subagents() { return findService(ctx, nano.subagents) },
        get agentChannel() { return findService(ctx, nano.agentChannel) },
        get webSearch() { return findService(ctx, nano.webSearch) },
        strategies: () => listContributions(ctx, nano.strategies),
      }
      const frontend = createFrontendRunnerRuntime(services)
      const main = createRunnerRuntime(services, frontend)
      ctx.effect(() => async () => {
        await main.cleanup()
        await frontend.cleanup()
      })
      await bootstrap.ensureSoulFilePlacement()
      const frontendSoul = config.frontend.enable ? await bootstrap.reconcileFrontendSoul() : undefined
      if (frontendSoul?.requiresFreshSession) await persistence.clearSession("frontend")
      await main.recoverModelSwapHandoff()
      if (frontendSoul?.conflicted) {
        frontend.activateFrontend({
          source: "system", triggeredAt: new Date().toISOString(), raw: null,
          content: "[frontend soul merge conflict] Your virtual memory://soul.md contains unresolved merge markers after the main soul changed. Read memory://soul.md, reconcile the main and frontend versions, then edit the virtual soul to remove all markers. Your edits update the frontend patch; the main soul is unchanged.",
        })
      }
      const service: RunnerService = {
        activate: (event) => main.activate(event),
        wake: (event) => main.wake(event),
        enqueue: (event, options) => main.enqueueEvent(event, options),
        status: () => main.getRunnerStatus(),
        interrupt: () => main.requestInterrupt(),
        discard: () => main.requestDiscard(),
        rest: (reason) => main.requestRest(reason),
        compact: (options) => main.requestCompaction(options),
        swapModel: (preset) => main.requestModelSwap(preset),
        modelSnapshot: () => {
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
        },
        trigger: async (source, body, signal) => {
          signal?.throwIfAborted()
          const event = source === "discord" ? fromDiscord(body)
            : source === "bsky" ? fromBsky(body)
              : source === "webhook" ? fromWebhook(body)
                : source === "cron" ? fromCron()
                  : fromChat(body)
          main.activate(event)
          return { ok: true, agentId: AGENT_ID, running: main.getRunnerStatus().running }
        },
      }
      const subscriptions = new Set<AbortController>()
      ctx.effect(() => () => {
        for (const controller of subscriptions) controller.abort()
        subscriptions.clear()
      })
      const conversation: ConversationService = {
        submit: async ({ event, runtimeKind }) => {
          if (runtimeKind === "frontend") frontend.activateFrontend(event)
          else main.activate(event)
          return { accepted: true, running: runtimeKind === "frontend" ? frontend.getFrontendRunnerStatus().running : main.getRunnerStatus().running }
        },
        history: (input) => persistence.history(input),
        subscribe: (input, signal) => {
          const controller = new AbortController()
          subscriptions.add(controller)
          const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
          const iterator = conversationEvents(input, combined)
          const release = () => { controller.abort(); subscriptions.delete(controller) }
          return {
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                const result = await iterator.next()
                if (result.done) subscriptions.delete(controller)
                return result
              },
              return: async () => { release(); return iterator.return(undefined) },
              throw: async (error?: unknown) => { release(); return iterator.throw(error) },
            }),
          }
        },
        cancel: async ({ runtimeKind }) => {
          if (runtimeKind === "frontend") frontend.requestInterrupt()
          else main.requestInterrupt()
        },
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
      onEvent(ctx, nano.wake, ({ runtimeKind, event, priority }) => {
        if (runtimeKind === "frontend") frontend.activateFrontend(event, { priority })
        else main.activate(event, { priority })
      })
      ctx.provide(nano.runner.name, service)
      ctx.provide(nano.conversation.name, conversation)
      registerContribution(ctx, nano.runtimeDelivery, "main", {
        runtimeKind: "main",
        deliver: (event) => { main.activate(event); return true },
        waiting: () => main.getRunnerStatus().idle,
        enqueue: (event, options) => main.enqueueEvent(event, options),
      })
      if (config.frontend.enable) registerContribution(ctx, nano.runtimeDelivery, "frontend", {
        runtimeKind: "frontend",
        deliver: (event) => { frontend.activateFrontend(event); return true },
        waiting: () => frontend.getFrontendRunnerStatus().idle,
        enqueue: (event: Parameters<typeof frontend.enqueueFrontendEvent>[0], options?: { onlyIfWaiting?: boolean; priority?: boolean }) => {
          if (options?.onlyIfWaiting && !frontend.getFrontendRunnerStatus().idle) return false
          return frontend.enqueueFrontendEvent(event, options)
        },
      })
      ctx.effect(() => {
        const timer = setTimeout(() => {
          main.startBoredomTimer()
          frontend.startFrontendBoredomTimer()
          void (async () => {
            await emitEvent(ctx, nano.runtimeReady, "main")
            if (config.frontend.enable) await emitEvent(ctx, nano.runtimeReady, "frontend")
          })().catch((error) => console.error("[runner] runtime-ready event failed:", error))
        }, 0)
        return () => clearTimeout(timer)
      })
    },
  }
}

export const runnerPlugin = createRunnerPlugin()
