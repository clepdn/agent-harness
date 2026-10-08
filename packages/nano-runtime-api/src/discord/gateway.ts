import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type GuildMember,
  type Interaction,
  type Message,
  type MessageReaction,
  type MessageReactionEventDetails,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js"
import type Database from "better-sqlite3"
import type { DiscordOwnerAlerts } from "./owner-alerts"
import { ingestDiscordEvent, type DiscordIngestResult } from "./state"
import { fromDiscordReaction, type DiscordTriggerOptions } from "../triggers/discord"
import { dispatchDiscordCommand, discordCommandDefinitions } from "./slash-commands"
import type { CommandContribution } from "../index"
import type { UserMessage } from "../types"

export type DiscordRuntimeKind = "main" | "frontend"
export type DiscordPresence = "awake" | "resting"

export type DiscordIngressOutcome = {
  ingested: boolean
  woke: boolean
  reason: string
  note?: string
}

export type DiscordDebounce = {
  noteDmTyping(channelId: string, userId?: string): void
  reset(): void
}

export type DiscordTyping = {
  configure(sender: ((channelId: string) => Promise<void> | void) | null, enabled?: boolean): void
  reset(): void
}

export type DiscordStatusUpdater = {
  start(client: Client): void
  stop(): void
}

export type DiscordActivityTrace = {
  start(): void
  stop(): void
}

export type DiscordVoiceService = {
  setClient(client: Client | null): void
  setDelegationCallback(callback: ((event: UserMessage) => void) | null): void
  getVoiceSessionStatus(): { active: boolean; channelId?: string; channelName?: string; guildId?: string; model?: string; voice: string }
  joinOwnerVoice(owner: GuildMember): Promise<unknown>
  leaveVoice(): Promise<boolean>
  setVoice(name: string): Promise<unknown>
  isVoiceChannelEmpty(channel: { members?: { values: () => Iterable<{ user?: { bot?: boolean } }> } } | null | undefined): boolean
  stop(): Promise<void>
  sendVoiceReply(id: string, text: string): { ok: boolean; error?: string; chunks?: number }
}

export type DiscordGatewayOptions = {
  db: Database.Database
  commands: readonly CommandContribution[] | (() => readonly CommandContribution[])
  enabled: boolean
  token: string
  trace: boolean
  rawFallback: boolean
  rawFallbackAll: boolean
  wakeOnReaction: boolean
  dmWhitelist: readonly string[]
  botUserId: string
  ownerId: string
  typingEnabled: boolean
  onIngress(payload: unknown): DiscordIngressOutcome | Promise<DiscordIngressOutcome>
  routeEvent(event: UserMessage, runtimeKind: DiscordRuntimeKind, priority?: boolean): void | Promise<void>
  deliveries?: readonly unknown[]
  debounce: DiscordDebounce
  typing: DiscordTyping
  statusUpdater: DiscordStatusUpdater
  activityTrace?: DiscordActivityTrace
  voice: DiscordVoiceService
  alerts: DiscordOwnerAlerts
  subscribePresence?: (listener: (presence: DiscordPresence) => void) => () => void
  runtimeFor?: (ingest: DiscordIngestResult) => DiscordRuntimeKind
  isConfiguredChannel?: (channelId: string) => boolean
  isChannelActive?: (channelId: string) => boolean
  trigger?: DiscordTriggerOptions
  onReady?: (userId: string) => void | Promise<void>
  signal?: AbortSignal
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function buildIngressPayload(message: Message): Record<string, unknown> {
  const channelName =
    message.channel && "name" in message.channel && typeof message.channel.name === "string"
      ? message.channel.name
      : null
  const channelTopic =
    message.channel && "topic" in message.channel && typeof message.channel.topic === "string"
      ? message.channel.topic
      : null

  return {
    message: {
      id: message.id,
      channel_id: message.channelId,
      guild_id: message.guildId ?? null,
      channel_type: message.channel?.type ?? null,
      content: message.content ?? "",
      timestamp: message.createdAt.toISOString(),
      message_reference: message.reference?.messageId
        ? {
            message_id: message.reference.messageId,
            channel_id: message.reference.channelId ?? message.channelId,
            guild_id: message.reference.guildId ?? message.guildId ?? null,
          }
        : null,
      author: {
        id: message.author.id,
        username: message.author.username,
        global_name: message.author.globalName ?? null,
        avatar: message.author.avatar,
        discriminator: message.author.discriminator,
        bot: message.author.bot,
      },
      member: message.member
        ? {
            nickname: message.member.nickname ?? null,
            display_name: message.member.displayName ?? null,
          }
        : null,
      mentions: message.mentions.users.map((u) => {
        const member = message.mentions.members?.get(u.id) ?? message.guild?.members.cache.get(u.id)
        return {
          id: u.id,
          username: u.username,
          global_name: u.globalName ?? null,
          nickname: member?.nickname ?? null,
          display_name: member?.displayName ?? null,
          bot: u.bot,
        }
      }),
      attachments: message.attachments.map((a) => ({
        id: a.id,
        url: a.url,
        proxy_url: a.proxyURL,
        filename: a.name,
        content_type: a.contentType ?? null,
        width: a.width ?? null,
        height: a.height ?? null,
        size: a.size,
      })),
    },
    channel: {
      id: message.channelId,
      type: message.channel?.type ?? null,
      guild_id: message.guildId ?? null,
      name: channelName,
      topic: channelTopic,
    },
    guild_name: message.guild?.name ?? null,
    is_dm: message.guildId == null,
  }
}

function buildReactionPayload(
  message: Message,
  reactor: User,
  emoji: { id: string | null; name: string | null; animated: boolean | null },
): Record<string, unknown> {
  const payload = buildIngressPayload(message)
  const member = message.guild?.members.cache.get(reactor.id)
  return {
    ...payload,
    reactor: {
      id: reactor.id,
      username: reactor.username,
      global_name: reactor.globalName ?? null,
      avatar: reactor.avatar,
      discriminator: reactor.discriminator,
      bot: reactor.bot,
    },
    reactor_member: member
      ? { nickname: member.nickname ?? null, display_name: member.displayName ?? null }
      : null,
    emoji,
    reacted_at: new Date().toISOString(),
  }
}
function reactionIsEligible(options: DiscordGatewayOptions, message: Message, reactor: User, botUserId: string): boolean {
  if (!options.wakeOnReaction || reactor.bot || reactor.id === botUserId) return false
  if (message.guildId == null) return options.dmWhitelist.length === 0 || options.dmWhitelist.includes(reactor.id)
  return (options.isConfiguredChannel ?? (() => false))(message.channelId) && (options.isChannelActive ?? (() => true))(message.channelId)
}

export type DiscordGatewayHandle = {
  stop: () => Promise<void>
  refreshCommands: () => Promise<void>
}

async function setDiscordPresence(client: Client, presence: DiscordPresence): Promise<void> {
  if (!client.user) return
  await client.user.setPresence(
    presence === "resting"
      ? {
          status: "idle",
          activities: [{ name: "resting", state: "resting", type: ActivityType.Custom }],
        }
      : { status: "online", activities: [] },
  )
}

export async function startDiscordGateway(options: DiscordGatewayOptions): Promise<DiscordGatewayHandle | null> {
  if (!options.enabled) {
    console.log("[discord gateway] disabled via [discord].gateway_enabled = false")
    return null
  }
  if (!options.token) {
    console.log("[discord gateway] [discord].bot_token not set; gateway listener disabled")
    return null
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
      GatewayIntentBits.DirectMessageTyping,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
  })
  let stopped = false
  let effectiveBotUserId = options.botUserId
  let latestPresence: DiscordPresence = "resting"
  let unsubscribePresence: (() => void) | null = null
  let commandRefresh = Promise.resolve()
  const refreshCommands = async (): Promise<void> => {
    if (stopped || !client.isReady() || !client.application) return
    const commands = typeof options.commands === "function" ? options.commands() : options.commands
    await client.application.commands.set(discordCommandDefinitions(commands))
  }
  const queueCommandRefresh = (): Promise<void> => {
    commandRefresh = commandRefresh.catch(() => {}).then(refreshCommands)
    return commandRefresh
  }
  let rejectReady: ((reason?: unknown) => void) | null = null
  let readySettled = false
  const sender = (channelId: string): Promise<void> => {
    const channel = client.channels.cache.get(channelId)
    if (!channel || !("sendTyping" in channel) || typeof channel.sendTyping !== "function") return Promise.resolve()
    return channel.sendTyping()
  }

  const onRaw = (packet: { t?: string; d?: Record<string, unknown> }) => {
    if (packet?.t === "TYPING_START") {
      const d = packet.d ?? {}
      const channelId = asString(d.channel_id)
      const guildId = asString(d.guild_id)
      if (channelId && !guildId) {
        options.debounce.noteDmTyping(channelId, asString(d.user_id))
        if (options.trace) console.log(`[discord gateway/raw] TYPING_START dm channel=${channelId} -> extend debounce`)
      }
      return
    }
    if (packet?.t !== "MESSAGE_CREATE" || !options.rawFallback) return
    const d = packet.d ?? {}
    const channelId = asString(d.channel_id)
    const guildId = asString(d.guild_id)
    const channelType = asNumber(d.channel_type)
    const cachedChannel = channelId ? client.channels.cache.get(channelId) : null
    const cachedType = typeof cachedChannel?.type === "number" ? cachedChannel.type : null
    const isDm =
      !guildId &&
      (channelType == null ||
        channelType === ChannelType.DM ||
        channelType === ChannelType.GroupDM ||
        cachedType === ChannelType.DM ||
        cachedType === ChannelType.GroupDM)
    if (!options.rawFallbackAll && !isDm) {
      if (options.trace) {
        console.log(
          `[discord gateway/raw] ignored MESSAGE_CREATE id=${String(d.id ?? "unknown")} channel=${channelId || "unknown"} guild=${guildId || "none"} type=${channelType ?? cachedType ?? "unknown"} reason=not_dm_fallback`,
        )
      }
      return
    }
    const author = (d.author ?? {}) as Record<string, unknown>
    void Promise.resolve(options.onIngress({ ...d, is_dm: isDm }))
      .then((result) => {
        if (options.trace) {
          console.log(
            `[discord gateway/raw] MESSAGE_CREATE id=${String(d.id ?? "unknown")} channel=${String(d.channel_id ?? "unknown")} guild=${String(d.guild_id ?? "dm")} author=${String(author.username ?? author.id ?? "unknown")} bot=${String(Boolean(author.bot))} ingested=${result.ingested} woke=${result.woke} reason=${result.reason}`,
          )
        }
      })
      .catch((err) => console.warn("[discord gateway/raw] failed to ingest message:", err))
  }

  const onVoiceStateUpdate = (
    oldState: { id: string; channelId: string | null; channel: { members?: { values: () => Iterable<{ user?: { bot?: boolean } }> } } | null },
    newState: { channelId: string | null; channel: { members?: { values: () => Iterable<{ user?: { bot?: boolean } }> } } | null },
  ) => {
    const active = options.voice.getVoiceSessionStatus()
    const affectedActiveChannel = active.active
      ? newState.channelId === active.channelId
        ? newState.channel
        : oldState.channelId === active.channelId
          ? oldState.channel
          : null
      : null
    if (active.active && affectedActiveChannel && options.voice.isVoiceChannelEmpty(affectedActiveChannel)) {
      void options.voice.leaveVoice().catch((err) => console.warn("[discord voice] auto-leave failed:", err))
      return
    }
    if (oldState.id !== options.ownerId || !oldState.channelId) return
    if (newState.channelId === oldState.channelId) return
    void options.voice.leaveVoice().catch((err) => console.warn("[discord voice] auto-leave failed:", err))
  }

  const onMessageCreate = (message: Message) => {
    void Promise.resolve(options.onIngress(buildIngressPayload(message)))
      .then((result) => {
        if (options.trace) {
          const channelType = typeof message.channel?.type === "number" ? message.channel.type : null
          console.log(
            `[discord gateway] messageCreate id=${message.id} channel=${message.channelId} guild=${message.guildId ?? "dm"} type=${channelType ?? "unknown"} is_dm=${message.guildId == null} ingested=${result.ingested} woke=${result.woke} reason=${result.reason}`,
          )
        }
      })
      .catch((err) => console.warn("[discord gateway] failed to ingest message:", err))
  }

  const onReaction = async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, _details: MessageReactionEventDetails) => {
    try {
      if (!options.wakeOnReaction || (!user.partial && user.bot)) return
      const resolvedUser: User = user.partial ? await user.fetch() : user
      const resolvedReaction: MessageReaction = reaction.partial ? await reaction.fetch() : reaction
      const message: Message = resolvedReaction.message.partial ? await resolvedReaction.message.fetch() : resolvedReaction.message
      if (!reactionIsEligible(options, message, resolvedUser, effectiveBotUserId)) return
      const ingest = ingestDiscordEvent(options.db, buildIngressPayload(message), { botUserId: effectiveBotUserId })
      const event = fromDiscordReaction(buildReactionPayload(message, resolvedUser, {
        id: resolvedReaction.emoji.id,
        name: resolvedReaction.emoji.name,
        animated: resolvedReaction.emoji.animated,
      }), options.trigger)
      const runtime = (options.runtimeFor ?? (() => "main" as const))({ ...ingest, stored: ingest.stored, isNew: true, authorId: resolvedUser.id, isDm: message.guildId == null })
      await options.routeEvent(event, runtime, message.guildId == null)
      if (options.trace) console.log(`[discord gateway] messageReactionAdd message=${message.id} channel=${message.channelId} guild=${message.guildId ?? "dm"} user=${resolvedUser.id} emoji=${resolvedReaction.emoji.identifier} runtime=${runtime}`)
    } catch (err) {
      console.warn("[discord gateway] failed to handle message reaction:", err)
    }
  }

  const onInteraction = async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand() || interaction.isAutocomplete()) {
        const commands = typeof options.commands === "function" ? options.commands() : options.commands
        await dispatchDiscordCommand(commands, interaction)
      } else if (interaction.isButton() && options.alerts.isButton(interaction)) {
        await options.alerts.handleButton(options.db, interaction)
      }
    } catch (err) {
      console.warn("[discord] interaction error:", err instanceof Error ? err.message : String(err))
      if ((interaction.isChatInputCommand() || interaction.isButton()) && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "an error occurred", ephemeral: true }).catch(() => {})
      }
    }
  }

  const onClientError = (err: Error) => console.warn("[discord gateway] client error:", err)
  const removeListeners = () => {
    client.off("raw", onRaw)
    client.off(Events.VoiceStateUpdate, onVoiceStateUpdate)
    client.off(Events.MessageCreate, onMessageCreate)
    client.off(Events.MessageReactionAdd, onReaction)
    client.off(Events.InteractionCreate, onInteraction)
    client.off(Events.Error, onClientError)
  }
  const stopSync = () => {
    if (stopped) return
    stopped = true
    if (!readySettled) rejectReady?.(new Error("Discord gateway stopped"))
    removeListeners()
    client.removeAllListeners(Events.ClientReady)
    unsubscribePresence?.()
    unsubscribePresence = null
    options.statusUpdater.stop()
    options.debounce.reset()
    options.typing.reset()
    options.typing.configure(null, false)
    options.alerts.setSender(null)
    options.voice.setClient(null)
  }

  const readyInitialization = new Promise<void>((resolve, reject) => {
    rejectReady = reject
    client.once(Events.ClientReady, (ready) => {
      void (async () => {
        try {
          if (stopped) return
          effectiveBotUserId = ready.user?.id ?? effectiveBotUserId
          console.log(`[discord gateway] connected as ${ready.user?.tag ?? ready.user?.id ?? "unknown"} (id=${ready.user?.id ?? "unknown"})`)
          await options.onReady?.(ready.user?.id ?? "")
          await setDiscordPresence(client, latestPresence)
          options.statusUpdater.start(client)
          await refreshCommands()
          readySettled = true
          resolve()
        } catch (err) {
          readySettled = true
          reject(err)
        }
      })()
    })
  })
  client.on("raw", onRaw)
  client.on(Events.VoiceStateUpdate, onVoiceStateUpdate)
  client.on(Events.MessageCreate, onMessageCreate)
  client.on(Events.MessageReactionAdd, onReaction)
  client.on(Events.InteractionCreate, onInteraction)
  client.on(Events.Error, onClientError)

  options.voice.setClient(client)
  options.voice.setDelegationCallback((event) => {
    void options.routeEvent(event, "main")
  })
  options.typing.configure(sender, options.typingEnabled)
  unsubscribePresence = options.subscribePresence?.((presence) => {
    latestPresence = presence
    if (client.isReady()) {
      void setDiscordPresence(client, presence).catch((err) => console.warn("[discord gateway] failed to update presence:", err))
    }
  }) ?? null
  options.alerts.setSender(async (payload) => {
    if (!options.ownerId) return
    const owner = await client.users.fetch(options.ownerId)
    await owner.send(payload)
  })
  const stop = async (): Promise<void> => {
    stopSync()
    await options.voice.stop()
    await client.destroy()
  }
  if (options.signal) {
    if (options.signal.aborted) {
      await stop()
      throw new Error("Discord gateway startup cancelled")
    }
    options.signal.addEventListener("abort", () => { void stop().catch((error) => console.warn("[discord gateway] stop after cancellation failed:", error)) }, { once: true })
  }

  try {
    await client.login(options.token)
    await readyInitialization
  } catch (err) {
    stopSync()
    await options.voice.stop()
    await client.destroy()
    throw err
  }

  return { stop, refreshCommands: queueCommandRefresh }
}
