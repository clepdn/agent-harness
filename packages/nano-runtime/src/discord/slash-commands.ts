/** Discord slash command contributions and their interaction handlers. */
import type { AutocompleteInteraction, ChatInputCommandInteraction, GuildMember, RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js"
import { SlashCommandBuilder } from "discord.js"
import type { CommandContext, CommandContribution, PluginScope } from "../plugins/api"
import { registerCommand } from "../plugins/api"

interface ModelDetails {
  readonly id: string
  readonly provider: string
  readonly baseUrl: string
}

interface RuntimeModelDetails {
  readonly primaryModel: ModelDetails | null
  readonly fallbackModel: ModelDetails
  readonly summaryModel: ModelDetails | null
  readonly primaryToolChoice: string
  readonly primaryVision: boolean
  readonly respectPromptCache: boolean
  readonly enableThinking: boolean
  readonly thinkingEffort: string
  readonly useFallback: boolean
}

interface ActivityTraceEntry {
  timestamp: number
  type: "text" | "thinking" | "tool" | "usage" | "user"
  text?: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    tokensPerSecond?: number
    cachedPromptTokens?: number
  }
  source?: string
}

interface VoiceStatus {
  readonly active: boolean
  readonly channelId?: string
  readonly channelName?: string
  readonly model?: string
  readonly voice: string
}

/** The smallest public runtime surface required by Discord's slash commands. */
export interface DiscordCommandServices {
  readonly ownerId?: string
  readonly model: {
    getFastMode(): boolean
    setFastMode(enabled?: boolean): boolean
    current(runtimeKind?: "main" | "frontend"): RuntimeModelDetails
    listPresets(): readonly string[]
  }
  readonly runner: {
    status(): { running: boolean; idle: boolean; contextSize: number; tokenCount: number; uptimeMs: number }
    interrupt(): "interrupted" | "idle" | "not-running"
    discard(): boolean
    compact(options: { forceSummaryModel: boolean; snapcompact: boolean }): boolean
    swapModel(preset: string): Promise<{
      preset: string
      model: string
      provider: string
      graceful: boolean
      fallbackReason?: string
    }>
  }
  readonly lifecycle?: { restart(reason?: string): void }
  readonly discord: {
    voiceStatus(): VoiceStatus
    joinVoice(member: GuildMember): Promise<VoiceStatus>
    leaveVoice(): Promise<boolean>
    setVoice(voice: string): Promise<string>
    supportedVoices: readonly string[]
  }
  readonly activityTrace: {
    start(): void
    getRecentActivity(count?: number): ActivityTraceEntry[]
    formatActivityTrace(entries: ActivityTraceEntry[]): string
    stop(): void
  }
}

export interface DiscordCommandMetadata {
  readonly definition: RESTPostAPIChatInputApplicationCommandsJSONBody
  readonly autocomplete?: boolean
}

function commandDefinitions(voiceNames: readonly string[]): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return [
    new SlashCommandBuilder()
      .setName("fast")
      .setDescription("Toggle priority service for Codex models")
      .addBooleanOption((opt) =>
        opt
          .setName("enabled")
          .setDescription("Turn fast mode on or off (omit to toggle)")
          .setRequired(false),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Show the agent's current runtime status")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("trace")
      .setDescription("Show recent agent activity (thinking, tool calls, text)")
      .addIntegerOption((opt) =>
        opt
          .setName("count")
          .setDescription("Number of recent events to show (default 15)")
          .setMinValue(5)
          .setMaxValue(50)
          .setRequired(false),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("restart")
      .setDescription("Restart the harness process")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("compact")
      .setDescription("Compact context now, regardless of token count")
      .addBooleanOption((opt) =>
        opt
          .setName("force")
          .setDescription("Use the configured small [summary] model no matter what")
          .setRequired(false),
      )
      .addBooleanOption((opt) =>
        opt
          .setName("snapcompact")
          .setDescription("Also preserve the discarded span as a snapcompact frame")
          .setRequired(false),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("interrupt")
      .setDescription("Interrupt the current generation or blocking job")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("discard")
      .setDescription("Archive and discard the entire running session")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("model")
      .setDescription("Model management")
      .addSubcommand((sub) =>
        sub.setName("info").setDescription("Show current model configuration"),
      )
      .addSubcommand((sub) =>
        sub
          .setName("swap")
          .setDescription("Swap to a different model preset")
          .addStringOption((opt) =>
            opt
              .setName("preset")
              .setDescription("Preset name from [models.<name>]")
              .setRequired(true)
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName("presets").setDescription("List available model presets"),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("join")
      .setDescription("Join your current voice channel for a realtime conversation")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("leave")
      .setDescription("Leave the active voice conversation")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("voice")
      .setDescription("Select the realtime voice")
      .addStringOption((opt) =>
        opt
          .setName("voice")
          .setDescription("Realtime output voice")
          .setRequired(true)
          .addChoices(...voiceNames.map((voice) => ({ name: voice, value: voice }))),
      )
      .toJSON(),
  ]
}

export function registerDiscordCommands(scope: PluginScope, services: DiscordCommandServices): () => void {
  const definitions = commandDefinitions(services.discord.supportedVoices)
  const unregister = definitions.map((definition) => registerCommand(scope, definition.name, {
    id: `discord.${definition.name}`,
    description: definition.description,
    discord: { definition, autocomplete: definition.name === "model" },
    execute: (input: unknown, context: CommandContext) => {
      if (context.signal.aborted) return
      if (isAutocompleteInteraction(input)) {
        if (definition.name !== "model") return
        return handleAutocomplete(input, services)
      }
      return handleInteraction(input as ChatInputCommandInteraction, services)
    },
  }))

  services.activityTrace.start()
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    services.activityTrace.stop()
    unregister.forEach((remove) => remove())
  }
}

export function discordCommandDefinitions(contributions: readonly CommandContribution[]): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return contributions.flatMap((contribution) => {
    const metadata = contribution.discord as DiscordCommandMetadata | undefined
    return metadata ? [metadata.definition] : []
  })
}

export async function dispatchDiscordCommand(
  contributions: readonly CommandContribution[],
  interaction: ChatInputCommandInteraction | AutocompleteInteraction,
): Promise<void> {
  const contribution = contributions.find((item) => item.id === `discord.${interaction.commandName}`)
  if (!contribution) return
  const metadata = contribution.discord as DiscordCommandMetadata | undefined
  if (interaction.isAutocomplete() && !metadata?.autocomplete) return
  await contribution.execute(interaction, { signal: new AbortController().signal })
}

function isAutocompleteInteraction(input: unknown): input is AutocompleteInteraction {
  return typeof input === "object" && input !== null &&
    "isAutocomplete" in input && typeof input.isAutocomplete === "function" && input.isAutocomplete()
}

async function handleInteraction(
  interaction: ChatInputCommandInteraction,
  services: DiscordCommandServices,
): Promise<void> {
  if (!services.ownerId || interaction.user.id !== services.ownerId) {
    await interaction.reply({ content: "you are not authorized to use this command", ephemeral: true })
    return
  }

  const subcommand = interaction.options.getSubcommand(false)
  switch (interaction.commandName) {
    case "fast":
      await handleFast(interaction, services)
      break
    case "status":
      await handleStatus(interaction, services)
      break
    case "trace":
      await handleTrace(interaction, services)
      break
    case "restart":
      await handleRestart(interaction, services)
      break
    case "compact":
      await handleCompact(interaction, services)
      break
    case "join":
      await handleJoin(interaction, services)
      break
    case "leave":
      await handleLeave(interaction, services)
      break
    case "voice":
      await handleVoice(interaction, services)
      break
    case "interrupt":
      await handleInterrupt(interaction, services)
      break
    case "discard":
      await handleDiscard(interaction, services)
      break
    case "model":
      switch (subcommand) {
        case "info":
          await handleModelInfo(interaction, services)
          break
        case "swap":
          await handleModelSwap(interaction, services)
          break
        case "presets":
          await handleModelPresets(interaction, services)
          break
        default:
          await interaction.reply({ content: "unknown subcommand", ephemeral: true })
      }
      break
    default:
      await interaction.reply({ content: "unknown command", ephemeral: true })
  }
}

async function handleAutocomplete(interaction: AutocompleteInteraction, services: DiscordCommandServices): Promise<void> {
  if (interaction.commandName !== "model") return
  if (interaction.options.getSubcommand(false) !== "swap") return

  const focused = interaction.options.getFocused()
  const presets = services.model.listPresets()
  const filtered = typeof focused === "string" && focused
    ? presets.filter((preset) => preset.toLowerCase().includes(focused.toLowerCase()))
    : presets
  await interaction.respond(filtered.slice(0, 25).map((preset) => ({ name: preset, value: preset })))
}

async function handleTrace(interaction: ChatInputCommandInteraction, services: DiscordCommandServices): Promise<void> {
  const count = interaction.options.getInteger("count") ?? 15
  const entries = services.activityTrace.getRecentActivity(count)
  const formatted = services.activityTrace.formatActivityTrace(entries)
  const truncated = formatted.length > 1950 ? formatted.slice(0, 1950) + "\n...(truncated)" : formatted
  await interaction.reply({ content: truncated, ephemeral: true })
}

async function handleJoin(interaction: ChatInputCommandInteraction, services: DiscordCommandServices): Promise<void> {
  if (!interaction.inGuild() || !interaction.member) {
    await interaction.reply({ content: "use /join in a server voice channel", ephemeral: true })
    return
  }
  await interaction.deferReply({ ephemeral: true })
  try {
    const member = await interaction.guild!.members.fetch(interaction.user.id)
    const status = await services.discord.joinVoice(member)
    await interaction.editReply(`joined **${status.channelName ?? status.channelId}** with **${status.model}**`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await interaction.editReply(`couldn't join voice: ${message}`)
  }
}

async function handleLeave(interaction: ChatInputCommandInteraction, services: DiscordCommandServices): Promise<void> {
  await interaction.deferReply({ ephemeral: true })
  const left = await services.discord.leaveVoice()
  await interaction.editReply(left ? "left the voice channel" : "i'm not in a voice channel")
}

async function handleVoice(interaction: ChatInputCommandInteraction, services: DiscordCommandServices): Promise<void> {
  const voice = interaction.options.getString("voice", true)
  await interaction.deferReply({ ephemeral: true })
  try {
    const selected = await services.discord.setVoice(voice)
    await interaction.editReply(`voice set to **${selected}**`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await interaction.editReply(`couldn't set voice: ${message}`)
  }
}

async function handleStatus(interaction: ChatInputCommandInteraction, services: DiscordCommandServices): Promise<void> {
  const status = services.runner.status()
  const model = services.model.current()
  const state = status.running ? (status.idle ? "idle (waiting for events)" : "working") : "resting"
  const modelId = model.primaryModel?.id ?? model.fallbackModel.id
  const voiceStatus = services.discord.voiceStatus()
  const lines = [
    `**state:** ${state}`,
    `**model:** ${modelId}`,
    `**context size:** ${status.contextSize.toLocaleString()} tokens`,
    `**total tokens:** ${status.tokenCount.toLocaleString()}`,
    `**uptime:** ${Math.floor(status.uptimeMs / 1000 / 60)} min`,
    `**respect prompt cache:** ${model.respectPromptCache}`,
    `**thinking:** ${model.enableThinking ? `on (${model.thinkingEffort})` : "off"}`,
    `**voice:** ${voiceStatus.active ? `connected (${voiceStatus.channelName ?? voiceStatus.channelId}, ${voiceStatus.model}, ${voiceStatus.voice})` : `disconnected (selected: ${voiceStatus.voice})`}`,
  ]
  await interaction.reply({ content: lines.join("\n"), ephemeral: true })
}

async function handleRestart(interaction: ChatInputCommandInteraction, services: DiscordCommandServices): Promise<void> {
  if (!services.lifecycle) {
    await interaction.reply({ content: "restart is not available", ephemeral: true })
    return
  }
  await interaction.reply({ content: "restarting...", ephemeral: true })
  services.lifecycle.restart("discord slash command /restart")
}

async function handleCompact(interaction: ChatInputCommandInteraction, services: DiscordCommandServices): Promise<void> {
  if (!services.runner.status().running) {
    await interaction.reply({ content: "not running - nothing to compact", ephemeral: true })
    return
  }
  const forceSummaryModel = interaction.options.getBoolean("force") ?? false
  const snapcompact = interaction.options.getBoolean("snapcompact") ?? false
  if (forceSummaryModel && !services.model.current().summaryModel) {
    await interaction.reply({
      content: "no dedicated `[summary]` model is configured, so `force=true` cannot run",
      ephemeral: true,
    })
    return
  }
  const idle = services.runner.status().idle
  const ok = services.runner.compact({ forceSummaryModel, snapcompact })
  if (!ok) {
    await interaction.reply({ content: "couldn't request compaction", ephemeral: true })
    return
  }
  await interaction.reply({
    content: (idle
      ? "compacting now (was idle)"
      : "compaction queued - will run at the next idle wait") +
      (forceSummaryModel ? " with the configured summary model" : "") +
      (snapcompact ? " + snapcompact" : ""),
    ephemeral: true,
  })
}

async function handleInterrupt(interaction: ChatInputCommandInteraction, services: DiscordCommandServices): Promise<void> {
  const result = services.runner.interrupt()
  const content = result === "interrupted"
    ? "interrupt requested"
    : result === "idle"
      ? "the runner is idle - nothing to interrupt"
      : "not running - nothing to interrupt"
  await interaction.reply({ content, ephemeral: true })
}

async function handleDiscard(interaction: ChatInputCommandInteraction, services: DiscordCommandServices): Promise<void> {
  const accepted = services.runner.discard()
  await interaction.reply({
    content: accepted
      ? "discarding the running session; its raw session JSON will be archived in `memories/`"
      : "not running - no session to discard",
    ephemeral: true,
  })
}

async function handleFast(interaction: ChatInputCommandInteraction, services: DiscordCommandServices): Promise<void> {
  const enabled = services.model.setFastMode(interaction.options.getBoolean("enabled") ?? undefined)
  await interaction.reply({
    content: `Codex fast mode **${enabled ? "on" : "off"}** — subsequent Codex requests use the **${enabled ? "priority" : "default"}** service tier.`,
    ephemeral: true,
  })
}

async function handleModelInfo(interaction: ChatInputCommandInteraction, services: DiscordCommandServices): Promise<void> {
  const model = services.model.current()
  const lines = [
    "**primary:** " + (model.primaryModel
      ? `${model.primaryModel.id} (${model.primaryModel.provider} @ ${model.primaryModel.baseUrl})`
      : "none"),
    "**fallback:** " + `${model.fallbackModel.id} (${model.fallbackModel.provider} @ ${model.fallbackModel.baseUrl})`,
    "**summary:** " + (model.summaryModel
      ? `${model.summaryModel.id} (${model.summaryModel.provider})`
      : "none"),
    `**respect prompt cache:** ${model.respectPromptCache}`,
    `**use fallback:** ${model.useFallback}`,
    `**thinking:** ${model.enableThinking ? `on (${model.thinkingEffort})` : "off"}`,
    `**Codex fast mode:** ${services.model.getFastMode() ? "on (priority)" : "off (default)"}`,
    `**tool choice:** ${model.primaryToolChoice}`,
    `**vision:** ${model.primaryVision}`,
  ]
  await interaction.reply({ content: lines.join("\n"), ephemeral: true })
}

async function handleModelSwap(interaction: ChatInputCommandInteraction, services: DiscordCommandServices): Promise<void> {
  const presetName = interaction.options.getString("preset", true).trim()
  await interaction.deferReply({ ephemeral: true })
  try {
    const result = await services.runner.swapModel(presetName)
    const disposition = result.graceful
      ? "The previous session completed its graceful end path; a fresh bootstrap is scheduled."
      : `The previous session was archived without a graceful journal/end: ${result.fallbackReason ?? "graceful handoff unavailable"}. A fresh bootstrap is scheduled.`
    await interaction.editReply(
      `Runtime selection is now preset **${result.preset}** (${result.model} via ${result.provider}). ${disposition} Remote backend identity is not verified.`,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/model swap already in progress|overlapping model swap/i.test(message)) {
      await interaction.editReply(`A model swap is already in progress: ${message}`)
    } else if (/model preset .* not found|preset .* has no model field|failed to build model from preset|preset is required/i.test(message)) {
      await interaction.editReply(`Invalid model preset: ${message}`)
    } else {
      await interaction.editReply(`Model swap failed: ${message}`)
    }
  }
}

async function handleModelPresets(interaction: ChatInputCommandInteraction, services: DiscordCommandServices): Promise<void> {
  const presets = services.model.listPresets()
  if (presets.length === 0) {
    await interaction.reply({ content: "no model presets configured", ephemeral: true })
    return
  }
  const current = services.model.current().primaryModel?.id ?? "(unknown)"
  const lines = presets.map((preset) => `- \`${preset}\``)
  await interaction.reply({
    content: `**available presets:**\n${lines.join("\n")}\n\n**current primary:** ${current}`,
    ephemeral: true,
  })
}
