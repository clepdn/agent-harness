import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type User,
} from "discord.js"
import { config, setDiscordBotUserId } from "../config"
import { activate } from "../runner/index"
import { activateFrontend } from "../runner/frontend"
import { handleDiscordIngress, discordRuntimeFor } from "./pipeline"
import { debounceChannelWake, debounceDmWake, noteDmTyping } from "./dm-debounce"
import { isConfiguredDiscordChannel, isDiscordMessageDispatched, markDiscordMessagesDispatched } from "./db"
import { ingestDiscordEvent, type DiscordIngestResult } from "./state"
import { fromDiscordMessages, fromDiscordReaction } from "../triggers/discord"
import { configureDiscordTyping, shouldSendDiscordTyping } from "./typing-lease"
import { registerSlashCommands, handleInteraction, handleAutocomplete } from "./slash-commands"
import { subscribeRunnerPresence, type RunnerPresence } from "../runner/presence"
import { startStatusUpdater, stopStatusUpdater } from "./status-updater"
import { getVoiceSessionStatus, isVoiceChannelEmpty, leaveVoice, setVoiceDelegationCallback, stopDiscordVoice } from "./voice"
import { startPrometheusServer, stopPrometheusServer } from "../prometheus"
import {
  configureOwnerAlertSender,
  handleOwnerAlertButton,
  isOwnerAlertButton,
} from "./owner-alerts"
import { isChannelActiveNow } from "./cooldown"

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

function reactionIsEligible(message: Message, reactor: User): boolean {
  if (!config.discord.wake_on_reaction || reactor.bot || reactor.id === config.discord.bot_user_id) return false
  if (message.guildId == null) {
    const allow = config.discord.dm_whitelist
    return allow.length === 0 || allow.includes(reactor.id)
  }
  return isConfiguredDiscordChannel(message.channelId) && isChannelActiveNow(message.channelId)
}

function payloadAuthorId(payload: unknown): string {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {}
  const message = root.message && typeof root.message === "object" ? root.message as Record<string, unknown> : root
  const author = message.author && typeof message.author === "object" ? message.author as Record<string, unknown> : {}
  return asString(author.id)
}

function handleGatewayMessage(payload: unknown) {
  const ingest: DiscordIngestResult = ingestDiscordEvent(payload)
  const channelId = ingest.channelId
  const fireQueued = (queued: readonly { payload: unknown; ingest: DiscordIngestResult }[]) => {
    const undispatched = queued.filter((item) => !isDiscordMessageDispatched(item.ingest.messageId))
    const latest = undispatched.at(-1)
    if (!latest) return
    const outcome = handleDiscordIngress(
      latest.payload,
      latest.ingest,
      fromDiscordMessages(undispatched.map((item) => item.payload)),
    )
    if (outcome.woke) {
      markDiscordMessagesDispatched(undispatched.flatMap((item) => item.ingest.messageId ?? []))
    }
  }
  if (ingest.isNew && ingest.bucket === "dm" && channelId) {
    const deferred = debounceDmWake(channelId, payloadAuthorId(payload), { payload, ingest }, fireQueued)
    if (deferred) return { ingested: ingest.stored, woke: false, reason: "dm_priority" as const, note: "debounced" }
  }
  if (
    ingest.isNew &&
    !ingest.isDm &&
    ingest.configured === true &&
    !ingest.isFromSelf &&
    config.discord.wake_on_event &&
    channelId
  ) {
    const deferred = debounceChannelWake(channelId, { payload, ingest }, fireQueued)
    if (deferred) return { ingested: ingest.stored, woke: false, reason: "wake_on_event" as const, note: "debounced" }
  }
  return handleDiscordIngress(payload, ingest)
}

export type DiscordGatewayHandle = {
  stop: () => Promise<void>
}

async function setDiscordPresence(client: Client, presence: RunnerPresence): Promise<void> {
  if (!client.user) return

  try {
    await client.user.setPresence(
      presence === "resting"
        ? {
            status: "idle",
            activities: [
              {
                name: "resting",
                state: "resting",
                type: ActivityType.Custom,
              },
            ],
          }
        : {
            status: "online",
            activities: [],
          },
    )
  } catch (err) {
    console.warn("[discord gateway] failed to update presence:", err)
  }
}

export async function startDiscordGateway(): Promise<DiscordGatewayHandle | null> {
  const enabled = config.discord.gateway_enabled
  const trace = config.discord.gateway_trace
  const rawFallback = config.discord.gateway_raw_fallback
  const rawFallbackAll = config.discord.gateway_raw_fallback_all
  if (!enabled) {
    console.log("[discord gateway] disabled via [discord].gateway_enabled = false")
    return null
  }

  const token = config.discord.bot_token
  if (!token) {
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

  setVoiceDelegationCallback((event) => activate(event))

  configureDiscordTyping((channelId) => {
    const channel = client.channels.cache.get(channelId)
    if (!shouldSendDiscordTyping(channel)) return Promise.resolve()
    if (!channel || !("sendTyping" in channel) || typeof channel.sendTyping !== "function") return Promise.resolve()
    return channel.sendTyping()
  })

  if (trace) {
    console.log("[discord gateway] trace enabled")
  }

  let latestPresence: RunnerPresence = "resting"
  let unsubscribePresence: (() => void) | null = null

  client.once(Events.ClientReady, (ready) => {
    if (!config.discord.bot_user_id && ready.user?.id) {
      setDiscordBotUserId(ready.user.id)
    }
    console.log(
      `[discord gateway] connected as ${ready.user?.tag ?? ready.user?.id ?? "unknown"} (id=${ready.user?.id ?? "unknown"})`,
    )
    void setDiscordPresence(client, latestPresence)
    startStatusUpdater(client)
    startPrometheusServer(config.prometheus?.port ?? 9100)
    void registerSlashCommands(client)
  })

  unsubscribePresence = subscribeRunnerPresence((presence) => {
    latestPresence = presence
    if (client.isReady()) void setDiscordPresence(client, presence)
  })

  client.on("raw", (packet: { t?: string; d?: Record<string, unknown> }) => {
    // Typing can only extend an existing DM message burst, never wake alone.
    if (packet?.t === "TYPING_START") {
      const d = packet.d ?? {}
      const channelId = asString(d.channel_id)
      const guildId = asString(d.guild_id)
      if (channelId && !guildId) {
        noteDmTyping(channelId, asString(d.user_id))
        if (trace) console.log(`[discord gateway/raw] TYPING_START dm channel=${channelId} -> extend debounce`)
      }
      return
    }
    if (packet?.t !== "MESSAGE_CREATE") return
    if (!rawFallback) return
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

    if (!rawFallbackAll && !isDm) {
      if (trace) {
        console.log(
          `[discord gateway/raw] ignored MESSAGE_CREATE id=${String(d.id ?? "unknown")} channel=${channelId || "unknown"} guild=${guildId || "none"} type=${channelType ?? cachedType ?? "unknown"} reason=not_dm_fallback`,
        )
      }
      return
    }

    const author = (d.author ?? {}) as Record<string, unknown>
    let ingestResultText = ""
    try {
      const result = handleGatewayMessage({ ...d, is_dm: isDm })
      ingestResultText = ` ingested=${result.ingested} woke=${result.woke} reason=${result.reason}`
    } catch (err) {
      ingestResultText = ` ingest_error=${err instanceof Error ? err.message : String(err)}`
    }

    if (trace) {
      console.log(
        `[discord gateway/raw] MESSAGE_CREATE id=${String(d.id ?? "unknown")} channel=${String(d.channel_id ?? "unknown")} guild=${String(d.guild_id ?? "dm")} author=${String(author.username ?? author.id ?? "unknown")} bot=${String(Boolean(author.bot))}${ingestResultText}`,
      )
    }
  })

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const active = getVoiceSessionStatus()
    const affectedActiveChannel = active.active && (
      newState.channelId === active.channelId ? newState.channel
        : oldState.channelId === active.channelId ? oldState.channel
          : null
    )
    if (active.active && affectedActiveChannel && isVoiceChannelEmpty(affectedActiveChannel)) {
      void leaveVoice().catch((err) => console.warn("[discord voice] auto-leave failed:", err))
      return
    }
    if (oldState.id !== config.discord.owner_id || !oldState.channelId) return
    if (newState.channelId === oldState.channelId) return
    // This also aborts an in-flight /join before it becomes an active session.
    void leaveVoice().catch((err) => console.warn("[discord voice] auto-leave failed:", err))
  })

  client.on(Events.MessageCreate, (message) => {
    try {
      const payload = buildIngressPayload(message)
      const result = handleGatewayMessage(payload)
      if (trace) {
        const channelType = typeof message.channel?.type === "number" ? message.channel.type : null
        const isDm = message.guildId == null
        console.log(
          `[discord gateway] messageCreate id=${message.id} channel=${message.channelId} guild=${message.guildId ?? "dm"} type=${channelType ?? "unknown"} is_dm=${isDm} ingested=${result.ingested} woke=${result.woke} reason=${result.reason}`,
        )
      }
    } catch (err) {
      console.warn("[discord gateway] failed to ingest message:", err)
    }
  })

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
      if (!config.discord.wake_on_reaction || (!user.partial && user.bot)) return
      const resolvedUser = user.partial ? await user.fetch() : user
      const resolvedReaction = reaction.partial ? await reaction.fetch() : reaction
      const message = resolvedReaction.message.partial
        ? await resolvedReaction.message.fetch()
        : resolvedReaction.message
      if (!reactionIsEligible(message, resolvedUser)) return

      // Keep the original message available to backread/reply tooling without
      // storing the reaction itself as a fake Discord message.
      ingestDiscordEvent(buildIngressPayload(message))
      const event = fromDiscordReaction(buildReactionPayload(message, resolvedUser, {
        id: resolvedReaction.emoji.id,
        name: resolvedReaction.emoji.name,
        animated: resolvedReaction.emoji.animated,
      }))
      const runtime = discordRuntimeFor({
        stored: false,
        isNew: true,
        authorId: resolvedUser.id,
        isDm: message.guildId == null,
      })
      if (runtime === "frontend") activateFrontend(event)
      else activate(event)

      if (trace) {
        console.log(
          `[discord gateway] messageReactionAdd message=${message.id} channel=${message.channelId} guild=${message.guildId ?? "dm"} user=${resolvedUser.id} emoji=${resolvedReaction.emoji.identifier} runtime=${runtime}`,
        )
      }
    } catch (err) {
      console.warn("[discord gateway] failed to handle message reaction:", err)
    }
  })

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleInteraction(interaction)
      } else if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction)
      } else if (interaction.isButton() && isOwnerAlertButton(interaction)) {
        await handleOwnerAlertButton(interaction)
      }
    } catch (err) {
      console.warn("[discord] interaction error:", err instanceof Error ? err.message : String(err))
      if ((interaction.isChatInputCommand() || interaction.isButton()) && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "an error occurred", ephemeral: true }).catch(() => {})
      }
    }
  })

  client.on(Events.Error, (err) => {
    console.warn("[discord gateway] client error:", err)
  })

  await client.login(token)
  configureOwnerAlertSender(async (payload) => {
    const ownerId = config.discord.owner_id
    if (!ownerId) return
    const owner = await client.users.fetch(ownerId)
    await owner.send(payload)
  })

  return {
    stop: async () => {
      configureOwnerAlertSender(null)
      unsubscribePresence?.()
      stopStatusUpdater()
      stopPrometheusServer()
      await stopDiscordVoice()
      setVoiceDelegationCallback(null)
      await client.destroy()
      configureDiscordTyping(null)
      console.log("[discord gateway] disconnected")
    },
  }
}
