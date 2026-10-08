import type { Plugin } from "@nano/plugins"
import type { JsonValue, WorkerOperationResult, DiscordChannel, DiscordMessage } from "@nano/protocol"
import type { GuildMember } from "discord.js"
import { nano, type MetricsService } from "./api"
import { config } from "../config"
import { handleDiscordIngress, type DiscordIngressOutcome } from "../discord/pipeline"
import { ingestDiscordEvent, type DiscordIngestResult, listDiscordBackread, listDiscordChannels, listDiscordInbox, markDiscordItem, scanDiscordChannels, sendDiscordMessage, setDiscordChannelNote, uploadDiscordFile } from "../discord/state"
import { searchDiscordMemoryEntries, searchDiscordMessages, pruneDiscordMemory, type DiscordEmbeddings } from "../discord/search"
import { getCachedPronouns, maybeFetchAndCachePronouns } from "../discord/pronouns"
import { getOrCreateDiscordFriendlyId } from "../discord/friendly-id"
import { markDiscordMessagesDispatched } from "../discord/db"
import { fromDiscordMessages } from "../triggers/discord"
import { discordEventImageReferences, loadDiscordAvatar } from "../discord/context-avatars"
import { loadDiscordEmoji } from "../discord/context-emojis"
import { createDiscordTypingLease, type DiscordTypingController } from "../discord/typing-lease"
import { createDiscordStatusUpdater } from "../discord/status-updater"
import { createDiscordActivityTrace } from "../discord/activity-trace"
import { createDiscordDebounce, type DiscordDebounce } from "../discord/dm-debounce"
import { createDiscordVoiceService, type DiscordVoiceService } from "../discord/voice"
import { createOwnerAlerts, type DiscordOwnerAlerts } from "../discord/owner-alerts"
import { isChannelActiveNow } from "../discord/cooldown"
import { registerDiscordCommands } from "../discord/slash-commands"
import { startDiscordGateway, type DiscordGatewayHandle } from "../discord/gateway"
import type { ClassifiedApiError } from "../api-errors"
import type { RuntimeKind } from "../runner/types"
import type { UserMessage, DiscordMessageTarget } from "../types"
import type { ContextImageAttachment, ContextImageReference } from "../context-images"
import type { DiscordMemorySearchResult } from "../memory/shared"
export interface DiscordSendMessageParams {
  channelId?: string
  content: string
  target?: unknown
  sourceItemId?: string
  referenceMessage?: string
  replyMode?: string
  turnTargets?: readonly DiscordMessageTarget[]
  runtimeKind?: RuntimeKind
}
export interface DiscordUploadFileParams extends DiscordSendMessageParams {
  filePath: string
}
export interface DiscordApplicationService {
  readonly available: boolean
  channels(): readonly DiscordChannel[]
  messages(channelId: string, before?: string, limit?: number): readonly DiscordMessage[]
  ingress(body: JsonValue, signal?: AbortSignal): Promise<WorkerOperationResult>
  searchMessages(query: string, limit: number, queryVector?: number[], runtimeKind?: RuntimeKind): Promise<readonly DiscordMemorySearchResult[]>
  listDiscordChannels(runtimeKind?: RuntimeKind): readonly unknown[]
  listDiscordInbox(limit?: number, status?: string[] | string, runtimeKind?: RuntimeKind): readonly unknown[]
  listDiscordBackread(channelId: string, limit?: number, beforeMessageId?: string, runtimeKind?: RuntimeKind): readonly unknown[]
  markDiscordItem(itemId: string, status: "pending" | "seen" | "acted" | "ignored", note?: string, action?: "none" | "replied" | "messaged" | "dismissed" | "noted", runtimeKind?: RuntimeKind): void
  scanDiscordChannels(params?: { limit?: number; channelIds?: string[] | string; beforeMessageId?: string; runtimeKind?: RuntimeKind }): Promise<Record<string, unknown>>
  sendDiscordMessage(params: DiscordSendMessageParams): Promise<Record<string, unknown>>
  uploadDiscordFile(params: DiscordUploadFileParams): Promise<Record<string, unknown>>
  setDiscordChannelNote(channelId: string, note: string, runtimeKind?: RuntimeKind): Record<string, unknown>
  setCustomStatus(text: string | null): void
  pruneDiscordMemory(id: string, reason: "explicit_request" | "surfaced_incorrect" | "surfaced_stale", note?: string, runtimeKind?: RuntimeKind): Record<string, unknown>
  searchDiscordMessages(params: { channelId: string; query?: string; messageId?: string; limit?: number; runtimeKind?: RuntimeKind }): Promise<Record<string, unknown>>
  setContextSize(tokens: number): void
  setWorking(active: boolean): void
  dispatchTyping(turnId: string, channelId: string): void
  stopTyping(turnId?: string): void
  notifyModelActivity(turnId: string): void
  beginToolWait(turnId: string): void
  endToolWait(turnId: string): void
  clearTypingScope(scope: { discordTypingTurnId?: string; discordTypingChannelId?: string }): void
  reportApiError(error: ClassifiedApiError): Promise<void>
  discordEventImageReferences(event: UserMessage): ContextImageReference[]
  refreshCommands(): Promise<void>
  loadContextAvatar(ref: Extract<ContextImageReference, { kind: "discord-avatar" }>): Promise<ContextImageAttachment>
  loadContextEmoji(ref: Extract<ContextImageReference, { kind: "discord-emoji" }>): Promise<ContextImageAttachment>
  readonly supportedVoices: readonly string[]
  voiceStatus(): { active: boolean; channelId?: string; channelName?: string; guildId?: string; model?: string; voice: string }
  joinVoice(member: GuildMember): Promise<{ active: boolean; channelId?: string; channelName?: string; guildId?: string; model?: string; voice: string }>
  leaveVoice(): Promise<boolean>
  setVoice(name: string): Promise<string>
  sendVoiceReply(id: string, text: string): { ok: boolean; error?: string; chunks?: number }
}

export interface DiscordPluginConfig {
  readonly requestRestart?: (reason?: string) => void
  readonly requestShutdown?: () => void
}

type IngressItem = {
  payload: unknown
  ingest: DiscordIngestResult
  resolve: (value: DiscordIngressOutcome) => void
  reject: (error: unknown) => void
  cancelled?: boolean
  unlinkAbort?: () => void
}

function createMetricsAdapter(metrics: MetricsService | undefined) {
  if (!metrics) return {}
  return {
    setApiRequestsInWindow: (value: number) => metrics.setApiRequestsInWindow(value),
    setProviderUsageRatio: (provider: string, model: string, ratio: number) => metrics.setProviderUsageRatio(provider, model, ratio),
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
export function createDiscordPlugin(): Plugin<DiscordPluginConfig> {
  return {
    id: "nano.discord",
    provides: [nano.discord],
    requires: [nano.persistence],
    optional: [nano.embeddings, nano.client, nano.metrics],
    apply(scope) {
      const persistence = scope.use(nano.persistence)
      const embeddings = scope.optional(nano.embeddings)
      const client = scope.optional(nano.client)
      const metrics = scope.optional(nano.metrics)
      const db = persistence.getDb()
      let gateway: DiscordGatewayHandle | null = null
      let discoveredBotUserId = config.discord.bot_user_id.trim()
      const getBotUserId = (): string => discoveredBotUserId
      const pronounController = new AbortController()
      const pronounFetches = new Map<string, Promise<void>>()
      let pronounQueue = Promise.resolve()
      scope.own(async () => {
        pronounController.abort()
        await pronounQueue
      })
      const schedulePronounFetch = (userId: string): void => {
        if (!userId || pronounFetches.has(userId) || pronounController.signal.aborted) return
        const signal = AbortSignal.any([scope.signal, pronounController.signal])
        const pending = pronounQueue.catch(() => {}).then(async () => {
          if (!signal.aborted) await maybeFetchAndCachePronouns(db, userId, signal)
        }).catch((error) => {
          if (!signal.aborted) console.warn(`[discord] pronoun enrichment failed for user ${userId}:`, error)
        }).finally(() => pronounFetches.delete(userId))
        pronounFetches.set(userId, pending)
        pronounQueue = pending
      }
      let disposed = false
      const pendingIngress = new Set<IngressItem>()
      const typing: DiscordTypingController = createDiscordTypingLease()
      const alerts: DiscordOwnerAlerts = createOwnerAlerts({ ownerId: scope.guard(() => config.discord.owner_id) })
      const statusUpdater = createDiscordStatusUpdater({ model: { api_key: config.model.api_key, base_url: config.model.base_url, model: config.model.model } }, createMetricsAdapter(metrics))
      const debounce: DiscordDebounce = createDiscordDebounce({ baseMs: () => config.discord.dm_wake_debounce_ms, capMs: () => config.discord.dm_wake_debounce_cap_ms })
      const voice: DiscordVoiceService = createDiscordVoiceService({ enabled: config.discord.voice_enabled, ownerId: config.discord.owner_id, bridgeUrl: config.llm_bridge_url, bridgeApiKey: config.llm_bridge_api_key, voiceModel: config.discord.voice_model, initialVoice: config.discord.voice, homeDir: persistence.home, routeEvent: (event) => { void scope.emit(nano.wake, { runtimeKind: "main", event, priority: true }) } })
      const trigger = { db, modelVision: config.model.vision, pronouns: (userId: string) => getCachedPronouns(db, userId), friendlyId: (messageId: string, channelId: string) => getOrCreateDiscordFriendlyId(db, messageId, channelId) }
      const runtimeFor = (ingest: DiscordIngestResult): RuntimeKind => {
        const ownerDm = ingest.isDm === true && Boolean(config.discord.owner_id) && ingest.authorId === config.discord.owner_id
        return config.frontend.enable && !ownerDm ? "frontend" : "main"
      }
      const wakeRuntime = (event: UserMessage, runtimeKind: RuntimeKind, options?: { priority?: boolean }) => scope.emit(nano.wake, { runtimeKind, event, priority: options?.priority })
      const completeIngress = (item: IngressItem): void => {
        if (!pendingIngress.delete(item)) return
        item.unlinkAbort?.()
        if (item.cancelled || disposed) {
          item.reject(new Error("Discord ingress scope is cancelled"))
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
      const embedding: DiscordEmbeddings | undefined = embeddings
      const service: DiscordApplicationService = {
        get available() { return gateway !== null },
        channels: scope.guard(() => listDiscordChannels(db).map(asDiscordChannel)),
        messages: scope.guard((channelId, before, limit) => listDiscordBackread(db, channelId, limit, before).map(asDiscordMessage)),
        ingress: scope.guard(async (body, signal) => { const result = await onIngress(body, signal); return { ok: result.ingested, running: result.woke } }),
        searchMessages: scope.guard((query, limit, queryVector, kind) => searchDiscordMemoryEntries(db, embedding, persistence.vecAvailable, query, limit, queryVector, kind)),
        listDiscordChannels: scope.guard((kind = "main") => listDiscordChannels(db, kind)),
        listDiscordInbox: scope.guard((limit = 20, status, kind = "main") => listDiscordInbox(db, limit, status, kind)),
        listDiscordBackread: scope.guard((channelId, limit = 40, before, kind = "main") => listDiscordBackread(db, channelId, limit, before, kind)),
        markDiscordItem: scope.guard((itemId, status, note = "", action = "none", kind = "main") => markDiscordItem(db, itemId, status, note, action, kind)),
        scanDiscordChannels: scope.guard((params) => scanDiscordChannels(db, params)),
        sendDiscordMessage: scope.guard((params) => sendDiscordMessage(db, params)),
        uploadDiscordFile: scope.guard((params) => { if (!client) throw new Error("Discord upload requires nano.client"); return uploadDiscordFile(db, client, params) }),
        setDiscordChannelNote: scope.guard((channelId, note, kind = "main") => setDiscordChannelNote(db, channelId, note, kind)),
        setCustomStatus: scope.guard((text) => statusUpdater.setCustomStatus(text)),
        pruneDiscordMemory: scope.guard((id, reason, note, kind = "main") => pruneDiscordMemory(db, persistence.vecAvailable, id, reason, note, kind)),
        searchDiscordMessages: scope.guard((params) => searchDiscordMessages(db, embedding, persistence.vecAvailable, params)),
        setContextSize: scope.guard((tokens) => statusUpdater.setContextSize(tokens)),
        setWorking: scope.guard((active) => { statusUpdater.setWorking(active); metrics?.setWorking(active) }),
        dispatchTyping: scope.guard((turnId, channelId) => typing.dispatch(turnId, channelId)),
        stopTyping: scope.guard((turnId) => typing.stop(turnId)),
        notifyModelActivity: scope.guard((turnId) => typing.notify(turnId)),
        beginToolWait: scope.guard((turnId) => typing.beginToolWait(turnId)),
        endToolWait: scope.guard((turnId) => typing.endToolWait(turnId)),
        clearTypingScope: scope.guard((typingScope) => typing.cleanup(typingScope)),
        reportApiError: scope.guard((error) => alerts.reportApiError(db, error)),
        discordEventImageReferences: scope.guard((event) => discordEventImageReferences(db, event, getBotUserId())),
        loadContextAvatar: scope.guard((ref) => loadDiscordAvatar(ref)),
        loadContextEmoji: scope.guard((ref) => loadDiscordEmoji(ref)),
        supportedVoices: voice.supportedVoices,
        voiceStatus: scope.guard(() => voice.getVoiceSessionStatus()),
        joinVoice: scope.guard((member) => voice.joinOwnerVoice(member)),
        leaveVoice: scope.guard(() => voice.leaveVoice()),
        setVoice: scope.guard((name) => voice.setVoice(name)),
        sendVoiceReply: scope.guard((id, text) => voice.sendVoiceReply(id, text)),
        refreshCommands: scope.guard(async () => { await gateway?.refreshCommands() }),
      }
      const removeService = scope.provide(nano.discord, service)
      const stopCommandWatch = scope.watch(nano.commands, () => {
        void service.refreshCommands().catch((error) => console.warn("[discord] failed to refresh commands:", error))
      })
      // Gateway startup is awaited below; failures reject plugin activation.
      const startup = startDiscordGateway({
        db,
        subscribePresence: (listener) => {
          const unsubscribe = persistence.subscribeWorkerEvents(scope.guard((event) => {
            if (event.type !== "runner.status" || !event.payload || typeof event.payload !== "object" || !("presence" in event.payload)) return
            const presence = event.payload.presence
            if (presence === "awake" || presence === "resting") listener(presence)
          }))
          scope.own(unsubscribe)
          return unsubscribe
        },
        commands: () => scope.list(nano.commands).map((entry) => entry.value),
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
        signal: scope.signal,
        routeEvent: (event, kind, priority) => scope.emit(nano.wake, { runtimeKind: kind, event, priority }),
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
      const started = startup.then((handle) => { gateway = handle; return handle })
      return started.then(
        () => async () => {
          disposed = true
          for (const item of [...pendingIngress]) { item.cancelled = true; completeIngress(item) }
          pendingIngress.clear()
          stopCommandWatch()
          debounce.reset()
          alerts.stop()
          typing.reset()
          statusUpdater.stop()
          await gateway?.stop()
          await voice.stop()
          await removeService()
        },
        async (error) => {
          disposed = true
          for (const item of [...pendingIngress]) { item.cancelled = true; completeIngress(item) }
          stopCommandWatch()
          debounce.reset()
          alerts.stop()
          typing.reset()
          statusUpdater.stop()
          await voice.stop()
          await removeService()
          throw error
        },
      )
    },
  }
}

export const discordPlugin = createDiscordPlugin()

export function createDiscordCommandsPlugin(): Plugin {
  return {
    id: "nano.discord-commands",
    requires: [nano.runner, nano.model, nano.events],
    optional: [nano.discord, nano.lifecycle],
    apply(scope) {
      const discord = scope.optional(nano.discord)
      if (!discord) return
      const trace = createDiscordActivityTrace(scope.use(nano.events).subscribe)
      const remove = registerDiscordCommands(scope, { ownerId: config.discord.owner_id, model: scope.use(nano.model), runner: scope.use(nano.runner), lifecycle: scope.optional(nano.lifecycle), discord, activityTrace: trace })
      return async () => { remove(); trace.stop() }
    },
  }
}

export const discordCommandsPlugin = createDiscordCommandsPlugin()
