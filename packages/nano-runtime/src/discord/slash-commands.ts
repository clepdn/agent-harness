/**
 * Discord slash commands for harness control.
 *
 * Commands are registered globally on startup and handled via the
 * INTERACTION_CREATE gateway event. Only the configured owner_id can use them.
 */

import type { Client, ChatInputCommandInteraction, AutocompleteInteraction } from "discord.js"
import { SlashCommandBuilder } from "discord.js"
import { config, listModelPresets } from "../config"
import { getCodexFastMode, setCodexFastMode } from "../codex-fast-mode"
import { getRunnerStatus, isRunning, isWaitingForEvent, requestRest, requestCompaction } from "../runner/index"
import { modelState, evaluateModelSwap, applyModelSwap } from "../runner/model-state"
import { startActivityTrace, getRecentActivity, formatActivityTrace } from "./activity-trace"

// ── Mutable callbacks set by index.ts after server starts ─────────────────────

export interface GatewayControlCallbacks {
  requestRestart?: (reason?: string) => void
  requestShutdown?: () => void
}

export const gatewayCallbacks: GatewayControlCallbacks = {}

export function setGatewayCallbacks(cb: GatewayControlCallbacks): void {
  Object.assign(gatewayCallbacks, cb)
}

// ── Command definitions ───────────────────────────────────────────────────────

const commands = [
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
    .setDescription("Force a compaction pass now, regardless of token count")
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
]

// ── Owner check ───────────────────────────────────────────────────────────────

function isOwner(userId: string): boolean {
  const ownerId = config.discord.owner_id
  if (!ownerId) return false
  return userId === ownerId
}

// ── Interaction handler ──────────────────────────────────────────────────────

export async function handleInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  // Owner check
  if (!isOwner(interaction.user.id)) {
    await interaction.reply({
      content: "you are not authorized to use this command",
      ephemeral: true,
    })
    return
  }

  const subcommand = interaction.options.getSubcommand(false)

  switch (interaction.commandName) {
    case "fast":
      await handleFast(interaction)
      break
    case "status":
      await handleStatus(interaction)
      break
    case "trace":
      await handleTrace(interaction)
      break
    case "restart":
      await handleRestart(interaction)
      break
    case "compact":
      await handleCompact(interaction)
      break
    case "model":
      switch (subcommand) {
        case "info":
          await handleModelInfo(interaction)
          break
        case "swap":
          await handleModelSwap(interaction)
          break
        case "presets":
          await handleModelPresets(interaction)
          break
        default:
          await interaction.reply({ content: "unknown subcommand", ephemeral: true })
      }
      break
    default:
      await interaction.reply({ content: "unknown command", ephemeral: true })
  }
}

// ── Autocomplete handler ─────────────────────────────────────────────────────

export async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (interaction.commandName !== "model") return
  if (interaction.options.getSubcommand(false) !== "swap") return

  const focused = interaction.options.getFocused()
  const presets = listModelPresets()
  const filtered = typeof focused === "string" && focused
    ? presets.filter((p) => p.toLowerCase().includes(focused.toLowerCase()))
    : presets

  await interaction.respond(
    filtered.slice(0, 25).map((p) => ({ name: p, value: p })),
  )
}

async function handleTrace(interaction: ChatInputCommandInteraction): Promise<void> {
  const count = interaction.options.getInteger("count") ?? 15
  const entries = getRecentActivity(count)
  const formatted = formatActivityTrace(entries)

  // Discord message limit is 2000 chars
  const truncated = formatted.length > 1950 ? formatted.slice(0, 1950) + "\n...(truncated)" : formatted

  await interaction.reply({ content: truncated, ephemeral: true })
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const status = getRunnerStatus()
  const state = isRunning() ? (isWaitingForEvent() ? "idle (waiting for events)" : "working") : "resting"
  const modelId = modelState.primaryModel?.id ?? modelState.fallbackModel.id
  const lines = [
    `**state:** ${state}`,
    `**model:** ${modelId}`,
    `**context size:** ${status.contextSize.toLocaleString()} tokens`,
    `**total tokens:** ${status.tokenCount.toLocaleString()}`,
    `**uptime:** ${Math.floor(status.uptimeMs / 1000 / 60)} min`,
    `**respect prompt cache:** ${modelState.respectPromptCache}`,
    `**thinking:** ${modelState.enableThinking ? `on (${modelState.thinkingEffort})` : "off"}`,
  ]

  await interaction.reply({ content: lines.join("\n"), ephemeral: true })
}

async function handleRestart(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!gatewayCallbacks.requestRestart) {
    await interaction.reply({ content: "restart is not available", ephemeral: true })
    return
  }

  await interaction.reply({ content: "restarting...", ephemeral: true })
  gatewayCallbacks.requestRestart("discord slash command /restart")
}

async function handleCompact(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isRunning()) {
    await interaction.reply({ content: "not running - nothing to compact", ephemeral: true })
    return
  }
  const idle = isWaitingForEvent()
  const ok = requestCompaction()
  if (!ok) {
    await interaction.reply({ content: "couldn't request compaction", ephemeral: true })
    return
  }
  await interaction.reply({
    content: idle
      ? "compacting now (was idle)"
      : "compaction queued - will run at the next idle wait",
    ephemeral: true,
  })
}

async function handleFast(interaction: ChatInputCommandInteraction): Promise<void> {
  const enabled = setCodexFastMode(interaction.options.getBoolean("enabled") ?? undefined)
  await interaction.reply({
    content: `Codex fast mode **${enabled ? "on" : "off"}** — subsequent Codex requests use the **${enabled ? "priority" : "default"}** service tier.`,
    ephemeral: true,
  })
}

async function handleModelInfo(interaction: ChatInputCommandInteraction): Promise<void> {
  const lines = [
    "**primary:** " + (modelState.primaryModel
      ? `${modelState.primaryModel.id} (${modelState.primaryModel.provider} @ ${modelState.primaryModel.baseUrl})`
      : "none"),
    "**fallback:** " + `${modelState.fallbackModel.id} (${modelState.fallbackModel.provider} @ ${modelState.fallbackModel.baseUrl})`,
    "**summary:** " + (modelState.summaryModel
      ? `${modelState.summaryModel.id} (${modelState.summaryModel.provider})`
      : "none"),
    `**respect prompt cache:** ${modelState.respectPromptCache}`,
    `**use fallback:** ${modelState.useFallback}`,
    `**thinking:** ${modelState.enableThinking ? `on (${modelState.thinkingEffort})` : "off"}`,
    `**Codex fast mode:** ${getCodexFastMode() ? "on (priority)" : "off (default)"}`,
    `**tool choice:** ${modelState.primaryToolChoice}`,
    `**vision:** ${modelState.primaryVision}`,
  ]

  await interaction.reply({ content: lines.join("\n"), ephemeral: true })
}

async function handleModelSwap(interaction: ChatInputCommandInteraction): Promise<void> {
  const presetName = interaction.options.getString("preset", true).trim()

  const status = getRunnerStatus()
  const currentContextSize = status.contextSize

  let decision
  try {
    decision = evaluateModelSwap(presetName, currentContextSize)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await interaction.reply({ content: `error: ${msg}`, ephemeral: true })
    return
  }

  if (decision.action === "swap") {
    applyModelSwap(decision)
    await interaction.reply({
      content: `swapped primary model to **${decision.model.id}** (preset: ${decision.preset})\ncontext carried over: ${currentContextSize.toLocaleString()} tokens`,
      ephemeral: true,
    })
    return
  }

  // action === "rest"
  const restReason = `model swap to "${presetName}" requires rest: ${decision.reason}`
  const restAccepted = requestRest(restReason)

  await interaction.reply({
    content: `model swap to **${presetName}** requires rest.\nreason: ${decision.reason}\nrest triggered: ${restAccepted}\nthe new model will be active on next wake`,
    ephemeral: true,
  })
}

async function handleModelPresets(interaction: ChatInputCommandInteraction): Promise<void> {
  const presets = listModelPresets()
  if (presets.length === 0) {
    await interaction.reply({ content: "no model presets configured", ephemeral: true })
    return
  }

  const current = modelState.primaryModel?.id ?? "(unknown)"
  const lines = presets.map((p) => `- \`${p}\``)
  await interaction.reply({
    content: `**available presets:**\n${lines.join("\n")}\n\n**current primary:** ${current}`,
    ephemeral: true,
  })
}

// ── Registration ──────────────────────────────────────────────────────────────

export async function registerSlashCommands(client: Client): Promise<void> {
  // Start capturing stream events for /trace
  startActivityTrace()

  if (!client.application) {
    console.warn("[slash] client.application not available; skipping command registration")
    return
  }

  try {
    await client.application.commands.set(commands)
    console.log(`[slash] registered ${commands.length} commands`)
  } catch (err) {
    console.warn("[slash] failed to register commands:", err instanceof Error ? err.message : String(err))
  }
}
