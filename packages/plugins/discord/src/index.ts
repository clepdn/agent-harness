import type { Plugin } from "@nano/plugins"
import type { DiscordChannel, DiscordMessage } from "@nano/protocol"
import { emitEvent, findService, getService, listContributions, nano, watchContributions } from "@nano/runtime-api"
import type { DiscordApplicationService, MetricsService } from "@nano/runtime-api"
import { config } from "@nano/runtime-api/config"
import { handleDiscordIngress, type DiscordIngressOutcome } from "./discord/pipeline"
import { searchDiscordMemoryEntries, searchDiscordMessages, pruneDiscordMemory } from "./discord/search"
import { ingestDiscordEvent, type DiscordIngestResult, listDiscordBackread, listDiscordChannels, listDiscordInbox, markDiscordItem, scanDiscordChannels, sendDiscordMessage, setDiscordChannelNote, uploadDiscordFile } from "./discord/state"
import { getCachedPronouns, maybeFetchAndCachePronouns } from "./discord/pronouns"
import { getOrCreateDiscordFriendlyId } from "./discord/friendly-id"
import { markDiscordMessagesDispatched } from "./discord/db"
import { fromDiscordMessages } from "./triggers/discord"
import { discordEventImageReferences, loadDiscordAvatar } from "./discord/context-avatars"
import { loadDiscordEmoji } from "./discord/context-emojis"
import { createDiscordTypingLease, type DiscordTypingController } from "./discord/typing-lease"
import { createDiscordStatusUpdater } from "./discord/status-updater"
import { createDiscordActivityTrace } from "./discord/activity-trace"
import { createDiscordDebounce, type DiscordDebounce } from "./discord/dm-debounce"
import { createDiscordVoiceService, type DiscordVoiceService } from "./discord/voice"
import { createOwnerAlerts, type DiscordOwnerAlerts } from "./discord/owner-alerts"
import { isChannelActiveNow } from "./discord/cooldown"
import { registerDiscordCommands } from "./discord/slash-commands"
import { startDiscordGateway, type DiscordGatewayHandle } from "./discord/gateway"
import type { RuntimeKind } from "@nano/runtime-api/contracts/runner"
import type { UserMessage } from "@nano/runtime-api/types"


type IngressItem = {
  payload: unknown
  ingest: DiscordIngestResult
  resolve: (value: DiscordIngressOutcome) => void
  reject: (error: unknown) => void
  cancelled?: boolean
  unlinkAbort?: () => void
}

function createMetricsAdapter(getMetrics: () => MetricsService | undefined) {
  return {
    setApiRequestsInWindow: (value: number) => getMetrics()?.setApiRequestsInWindow(value),
    setProviderUsageRatio: (provider: string, model: string, ratio: number) => getMetrics()?.setProviderUsageRatio(provider, model, ratio),
  }
}

type UnknownRecord = Record<string, unknown>
function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null
}
function asDiscordChannel(value: unknown): DiscordChannel {
  const row = asRecord(value)
  const channelId = row?.channel_id
  const configured = row?.configured
  const guildId = row?.guild_id
  const guildName = row?.guild_name
  const channelName = row?.channel_name
  const channelType = row?.channel_type
  const isDm = row?.is_dm
  const topic = row?.topic
  const note = row?.note
  const lastNoteAt = row?.last_note_at
  const lastSeenAt = row?.last_seen_at
  if (typeof channelId !== "string" || (typeof configured !== "number" && typeof configured !== "boolean") ||
    (guildId !== null && typeof guildId !== "string") || (guildName !== null && typeof guildName !== "string") ||
    (channelName !== null && typeof channelName !== "string") || (channelType !== null && typeof channelType !== "number") ||
    (typeof isDm !== "number" && typeof isDm !== "boolean") || (topic !== null && typeof topic !== "string") ||
    (note !== null && typeof note !== "string") || (lastNoteAt !== null && typeof lastNoteAt !== "string") ||
    typeof lastSeenAt !== "string") throw new Error("invalid Discord channel row")
  return { channel_id: channelId, configured, guild_id: guildId, guild_name: guildName, channel_name: channelName, channel_type: channelType, is_dm: isDm, topic, note, last_note_at: lastNoteAt, last_seen_at: lastSeenAt }
}
function asDiscordMessage(value: unknown): DiscordMessage {
  const row = asRecord(value)
  const messageId = row?.message_id
  const channelId = row?.channel_id
  const guildId = row?.guild_id
  const authorId = row?.author_id
  const authorUsername = row?.author_username
  const content = row?.content
  const createdAt = row?.created_at
  const isDm = row?.is_dm
  const mentionsBot = row?.mentions_bot
  const isFromBot = row?.is_from_bot
  if (typeof messageId !== "string" || typeof channelId !== "string" ||
    (guildId !== null && typeof guildId !== "string") || (authorId !== null && typeof authorId !== "string") ||
    (authorUsername !== null && typeof authorUsername !== "string") || typeof content !== "string" ||
    typeof createdAt !== "string" || (typeof isDm !== "number" && typeof isDm !== "boolean") ||
    (typeof mentionsBot !== "number" && typeof mentionsBot !== "boolean") ||
    (typeof isFromBot !== "number" && typeof isFromBot !== "boolean")) throw new Error("invalid Discord message row")
  return { message_id: messageId, channel_id: channelId, guild_id: guildId, author_id: authorId, author_username: authorUsername, content, created_at: createdAt, is_dm: isDm, mentions_bot: mentionsBot, is_from_bot: isFromBot }
}
export interface DiscordPluginDependencies {
  readonly startGateway?: typeof startDiscordGateway
}

export function createDiscordPlugin(dependencies: DiscordPluginDependencies = {}): Plugin {
  const startGateway = dependencies.startGateway ?? startDiscordGateway
  return {
    name: "nano.discord",
    inject: [nano.persistence.name, "nano.contributions"],
    provide: nano.discord.name,
    async apply(ctx) {
      const persistence = getService(ctx, nano.persistence)
      const db = persistence.getDb()
      let gateway: DiscordGatewayHandle | null = null
      let gatewayStartup: Promise<DiscordGatewayHandle | null> | undefined
      let discoveredBotUserId = config.discord.bot_user_id.trim()
      const getBotUserId = (): string => discoveredBotUserId
      const pronounController = new AbortController()
      const gatewayController = new AbortController()
      const pronounFetches = new Map<string, Promise<void>>()
      let pronounQueue = Promise.resolve()
      const schedulePronounFetch = (userId: string): void => {
        if (!userId || pronounFetches.has(userId) || pronounController.signal.aborted) return
        const signal = pronounController.signal
        const pending = pronounQueue.catch(() => {}).then(async () => {
          if (!signal.aborted) await maybeFetchAndCachePronouns(db, userId, signal)
        }).catch((error) => {
          if (!signal.aborted) console.warn(`[discord] pronoun enrichment failed for user ${userId}:`, error)
        }).finally(() => pronounFetches.delete(userId))
        pronounFetches.set(userId, pending)
        pronounQueue = pending
      }
      const typing: DiscordTypingController = createDiscordTypingLease()
      const alerts: DiscordOwnerAlerts = createOwnerAlerts({ ownerId: () => config.discord.owner_id })
      const statusUpdater = createDiscordStatusUpdater(
        { model: { api_key: config.model.api_key, base_url: config.model.base_url, model: config.model.model } },
        createMetricsAdapter(() => findService(ctx, nano.metrics)),
      )
      const debounce: DiscordDebounce = createDiscordDebounce({ baseMs: () => config.discord.dm_wake_debounce_ms, capMs: () => config.discord.dm_wake_debounce_cap_ms })
      const voice: DiscordVoiceService = createDiscordVoiceService({
        enabled: config.discord.voice_enabled,
        ownerId: config.discord.owner_id,
        bridgeUrl: config.llm_bridge_url,
        bridgeApiKey: config.llm_bridge_api_key,
        voiceModel: config.discord.voice_model,
        initialVoice: config.discord.voice,
        homeDir: persistence.home,
        routeEvent: (event) => { void emitEvent(ctx, nano.wake, { runtimeKind: "main", event, priority: true }).catch((error) => console.warn("[discord] voice event dispatch failed:", error)) },
      })
      const trigger = { db, modelVision: config.model.vision, pronouns: (userId: string) => getCachedPronouns(db, userId), friendlyId: (messageId: string, channelId: string) => getOrCreateDiscordFriendlyId(db, messageId, channelId) }
      const runtimeFor = (ingest: DiscordIngestResult): RuntimeKind => {
        const ownerDm = ingest.isDm === true && Boolean(config.discord.owner_id) && ingest.authorId === config.discord.owner_id
        return config.frontend.enable && !ownerDm ? "frontend" : "main"
      }
      const wakeRuntime = (event: UserMessage, runtimeKind: RuntimeKind, options?: { priority?: boolean }) => emitEvent(ctx, nano.wake, { runtimeKind, event, priority: options?.priority })
      const pendingIngress = new Set<IngressItem>()
      const completeIngress = (item: IngressItem): void => {
        if (!pendingIngress.delete(item)) return
        item.unlinkAbort?.()
        if (item.cancelled) {
          item.reject(new Error("Discord ingress was cancelled"))
          return
        }
        try { item.resolve(handleDiscordIngress(db, item.payload, wakeRuntime, item.ingest, undefined, { trigger, runtimeFor })) }
        catch (error) { item.reject(error) }
      }
      const onIngress = (payload: unknown, signal?: AbortSignal): Promise<DiscordIngressOutcome> => {
        const ingest = ingestDiscordEvent(db, payload, { botUserId: getBotUserId() })
        if (ingest.stored && ingest.isNew && !ingest.isFromBot && ingest.authorId && !signal?.aborted) schedulePronounFetch(ingest.authorId)
        let resolveIngress!: (value: DiscordIngressOutcome) => void
        let rejectIngress!: (error: unknown) => void
        const promise = new Promise<DiscordIngressOutcome>((resolve, reject) => { resolveIngress = resolve; rejectIngress = reject })
        const item: IngressItem = { payload, ingest, resolve: resolveIngress, reject: rejectIngress }
        pendingIngress.add(item)
        const onAbort = () => { item.cancelled = true; completeIngress(item) }
        if (signal?.aborted) onAbort()
        else if (signal) {
          signal.addEventListener("abort", onAbort, { once: true })
          item.unlinkAbort = () => signal.removeEventListener("abort", onAbort)
        }
        const fire = (items: readonly IngressItem[]) => {
          const queued = items.filter((candidate) => pendingIngress.has(candidate) && !candidate.cancelled)
          if (!queued.length) return
          let outcome: DiscordIngressOutcome
          try {
            const latest = queued[queued.length - 1]!
            const event = fromDiscordMessages(queued.map((candidate) => candidate.payload), trigger)
            outcome = handleDiscordIngress(db, latest.payload, wakeRuntime, latest.ingest, event, { trigger, runtimeFor })
            if (outcome.woke) markDiscordMessagesDispatched(db, queued.flatMap((candidate) => candidate.ingest.messageId ? [candidate.ingest.messageId] : []))
          } catch (error) {
            for (const candidate of queued) { pendingIngress.delete(candidate); candidate.unlinkAbort?.(); candidate.reject(error) }
            return
          }
          for (const candidate of queued) { pendingIngress.delete(candidate); candidate.unlinkAbort?.(); candidate.resolve({ ...outcome, ingested: candidate.ingest.stored }) }
        }
        const channelId = ingest.channelId
        if (ingest.isNew && channelId && ingest.bucket === "dm" && debounce.debounceDmWake(channelId, String(ingest.authorId ?? ""), item, fire)) return promise
        if (ingest.isNew && channelId && !ingest.isDm && ingest.configured === true && config.discord.wake_on_event && debounce.debounceChannelWake(channelId, item, fire)) return promise
        completeIngress(item)
        return promise
      }
      const service: DiscordApplicationService = {
        get available() { return gateway !== null },
        channels: () => listDiscordChannels(db).map(asDiscordChannel),
        messages: (channelId, before, limit) => listDiscordBackread(db, channelId, limit, before).map(asDiscordMessage),
        ingress: async (body, signal) => { const result = await onIngress(body, signal); return { ok: result.ingested, running: result.woke } },
        searchMessages: (query, limit, queryVector, kind) => searchDiscordMemoryEntries(db, findService(ctx, nano.embeddings), persistence.vecAvailable, query, limit, queryVector, kind),
        listDiscordChannels: (kind = "main") => listDiscordChannels(db, kind),
        listDiscordInbox: (limit = 20, status, kind = "main") => listDiscordInbox(db, limit, status, kind),
        listDiscordBackread: (channelId, limit = 40, before, kind = "main") => listDiscordBackread(db, channelId, limit, before, kind),
        markDiscordItem: (itemId, status, note = "", action = "none", kind = "main") => markDiscordItem(db, itemId, status, note, action, kind),
        scanDiscordChannels: (params) => scanDiscordChannels(db, params),
        sendDiscordMessage: (params) => sendDiscordMessage(db, params),
        uploadDiscordFile: (params) => {
          const client = findService(ctx, nano.client)
          if (!client) throw new Error("Discord upload requires nano.client")
          return uploadDiscordFile(db, client, params)
        },
        setDiscordChannelNote: (channelId, note, kind = "main") => setDiscordChannelNote(db, channelId, note, kind),
        setCustomStatus: (text) => statusUpdater.setCustomStatus(text),
        pruneDiscordMemory: (id, reason, note, kind = "main") => pruneDiscordMemory(db, persistence.vecAvailable, id, reason, note, kind),
        searchDiscordMessages: (params) => searchDiscordMessages(db, findService(ctx, nano.embeddings), persistence.vecAvailable, params),
        setContextSize: (tokens) => statusUpdater.setContextSize(tokens),
        setWorking: (active) => { statusUpdater.setWorking(active); findService(ctx, nano.metrics)?.setWorking(active) },
        dispatchTyping: (turnId, channelId) => typing.dispatch(turnId, channelId),
        stopTyping: (turnId) => typing.stop(turnId),
        notifyModelActivity: (turnId) => typing.notify(turnId),
        beginToolWait: (turnId) => typing.beginToolWait(turnId),
        endToolWait: (turnId) => typing.endToolWait(turnId),
        clearTypingScope: (typingScope) => typing.cleanup(typingScope),
        reportApiError: (error) => alerts.reportApiError(db, error),
        discordEventImageReferences: (event) => discordEventImageReferences(db, event, getBotUserId()),
        loadContextAvatar: (ref) => loadDiscordAvatar(ref),
        loadContextEmoji: (ref) => loadDiscordEmoji(ref),
        supportedVoices: voice.supportedVoices,
        voiceStatus: () => voice.getVoiceSessionStatus(),
        joinVoice: (member) => voice.joinOwnerVoice(member),
        leaveVoice: () => voice.leaveVoice(),
        setVoice: (name) => voice.setVoice(name),
        sendVoiceReply: (id, text) => voice.sendVoiceReply(id, text),
        refreshCommands: async () => { await gateway?.refreshCommands() },
      }
      ctx.provide(nano.discord.name, service)
      watchContributions(ctx, nano.commands, () => {
        void service.refreshCommands().catch((error) => console.warn("[discord] failed to refresh commands:", error))
      })
      const presenceUnsubscribers = new Set<() => void>()
      ctx.effect(() => async () => {
        gatewayController.abort()
        pronounController.abort()
        await pronounQueue
        await gatewayStartup?.catch(() => {})
        for (const item of [...pendingIngress]) { item.cancelled = true; completeIngress(item) }
        pendingIngress.clear()
        for (const unsubscribe of presenceUnsubscribers) unsubscribe()
        presenceUnsubscribers.clear()
        debounce.reset()
        alerts.stop()
        typing.reset()
        statusUpdater.stop()
        await gateway?.stop()
        await voice.stop()
      })
      const startup = startGateway({
        db,
        subscribePresence: (listener) => {
          const unsubscribe = persistence.subscribeWorkerEvents((event) => {
            if (event.type !== "runner.status" || !event.payload || typeof event.payload !== "object" || !("presence" in event.payload)) return
            const presence = event.payload.presence
            if (presence === "awake" || presence === "resting") listener(presence)
          })
          presenceUnsubscribers.add(unsubscribe)
          return () => {
            if (presenceUnsubscribers.delete(unsubscribe)) unsubscribe()
          }
        },
        commands: () => listContributions(ctx, nano.commands).map((entry) => entry.value),
        enabled: config.discord.gateway_enabled,
        token: config.discord.bot_token,
        trace: config.discord.gateway_trace,
        rawFallback: config.discord.gateway_raw_fallback,
        rawFallbackAll: config.discord.gateway_raw_fallback_all,
        wakeOnReaction: config.discord.wake_on_reaction,
        dmWhitelist: config.discord.dm_whitelist,
        botUserId: getBotUserId(),
        ownerId: config.discord.owner_id,
        typingEnabled: config.discord.typing_enabled,
        onIngress,
        onReady: (userId) => { if (userId) discoveredBotUserId = userId },
        signal: gatewayController.signal,
        routeEvent: (event, kind, priority) => emitEvent(ctx, nano.wake, { runtimeKind: kind, event, priority }),
        debounce,
        typing,
        statusUpdater,
        voice,
        alerts,
        runtimeFor,
        isConfiguredChannel: (channelId) => listDiscordChannels(db).some((channel) => typeof channel === "object" && channel !== null && "channel_id" in channel && channel.channel_id === channelId),
        isChannelActive: (channelId) => isChannelActiveNow(channelId),
        trigger,
      })
      gatewayStartup = startup
      try {
        gateway = await startup
      } catch (error) {
        console.warn("[discord gateway] startup failed:", error)
      }
    },
  }
}

export const discordPlugin = createDiscordPlugin()

export function createDiscordCommandsPlugin(): Plugin {
  return {
    name: "nano.discord-commands",
    inject: [nano.runner.name, nano.model.name, nano.events.name],
    apply(ctx) {
      const runner = getService(ctx, nano.runner)
      const model = getService(ctx, nano.model)
      const events = getService(ctx, nano.events)
      ctx.inject([nano.discord.name, "nano.contributions"], (discordCtx) => {
        const discord = getService(discordCtx, nano.discord)
        const trace = createDiscordActivityTrace(events.subscribe)
        registerDiscordCommands(discordCtx, {
          ownerId: config.discord.owner_id,
          model,
          runner,
          lifecycle: findService(discordCtx, nano.lifecycle),
          discord,
          activityTrace: trace,
        })
      })
    },
  }
}

export const discordCommandsPlugin = createDiscordCommandsPlugin()
