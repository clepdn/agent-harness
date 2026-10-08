import assert from "node:assert/strict"
import test from "node:test"
import { PluginBus } from "@nano/plugins"
import type { ChatInputCommandInteraction } from "discord.js"
import { nano, type CommandContribution } from "../plugins/api"
import { discordCommandDefinitions, registerDiscordCommands, dispatchDiscordCommand, type DiscordCommandServices } from "./slash-commands"

const details = { id: "model", provider: "openai", baseUrl: "https://example.invalid" }

function services(): DiscordCommandServices {
  let fastMode = false
  return {
    ownerId: "owner",
    model: {
      getFastMode: () => fastMode,
      setFastMode(enabled) { fastMode = enabled ?? !fastMode; return fastMode },
      current: () => ({
        primaryModel: details, fallbackModel: details, summaryModel: null,
        primaryToolChoice: "auto", primaryVision: false, respectPromptCache: true,
        enableThinking: false, thinkingEffort: "low", useFallback: false,
      }),
      listPresets: () => ["default"],
    },
    runner: {
      status: () => ({ running: false, idle: false, contextSize: 0, tokenCount: 0, uptimeMs: 0 }),
      interrupt: () => "not-running",
      discard: () => false,
      compact: () => false,
      swapModel: async (preset) => ({ preset, model: "model", provider: "openai", graceful: true }),
    },
    discord: {
      voiceStatus: () => ({ active: false, voice: "juniper" }),
      joinVoice: async () => ({ active: false, voice: "juniper" }),
      leaveVoice: async () => false,
      setVoice: async (voice) => voice,
      supportedVoices: ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"],
    },
    activityTrace: { start() {}, getRecentActivity: () => [], formatActivityTrace: () => "", stop() {} },
  }
}

async function commandContributions(commandServices: DiscordCommandServices): Promise<{ bus: PluginBus; contributions: readonly CommandContribution[] }> {
  const bus = new PluginBus()
  await bus.install({
    id: "discord-command-fixture",
    apply(scope) { registerDiscordCommands(scope, commandServices) },
  })
  return { bus, contributions: bus.list(nano.commands).map(({ value }) => value) }
}

type FakeChatInputInteraction = {
  commandName: string
  user: { id: string }
  options: {
    getSubcommand: (required?: boolean) => string | null
    getBoolean: (name?: string) => boolean | null
    getInteger: (name?: string) => number | null
    getString: (name: string, required?: boolean) => string
  }
  reply: (reply: { content: string; ephemeral: boolean }) => Promise<void>
  deferReply: () => Promise<void>
  editReply: (content: string) => Promise<void>
  isAutocomplete: () => false
  inGuild: () => false
  member: null
}

function interaction(commandName: string, userId = "owner") {
  const replies: Array<{ content: string; ephemeral: boolean }> = []
  const options: FakeChatInputInteraction["options"] = {
    getSubcommand: () => commandName === "model" ? "info" : null,
    getBoolean: () => null,
    getInteger: () => null,
    getString: () => "juniper",
  }
  const value: FakeChatInputInteraction = {
    commandName,
    user: { id: userId },
    options,
    reply: async (reply) => { replies.push(reply) },
    deferReply: async () => {},
    editReply: async (content) => { replies.push({ content, ephemeral: true }) },
    isAutocomplete: () => false,
    inGuild: () => false,
    member: null,
  }
  return { value, replies }
}

test("voice changes acknowledge before a pending reconnect settles", async (t) => {
  const commandServices = services()
  let settle!: (voice: string) => void
  commandServices.discord.setVoice = async () => new Promise<string>((resolve) => { settle = resolve })
  const registered = await commandContributions(commandServices)
  t.after(() => registered.bus.close())
  const current = interaction("voice")
  let acknowledged = false
  current.value.deferReply = async () => { acknowledged = true }
  const running = dispatchDiscordCommand(registered.contributions, current.value as unknown as ChatInputCommandInteraction)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(acknowledged, true)
  assert.equal(current.replies.length, 0)
  settle("juniper")
  await running
  assert.equal(current.replies.length, 1)
  assert.match(current.replies[0]!.content, /juniper/)
})

test("voice commands are registered alongside /fast", async (t) => {
  const registered: string[] = []
  const commandServices = services()
  const bus = new PluginBus()
  await bus.install({
    id: "discord-command-registration",
    apply(scope) {
      const unregister = registerDiscordCommands(scope, commandServices)
      t.after(unregister)
    },
  })
  t.after(() => bus.close())
  const contributions = bus.list(nano.commands)
  const commands = discordCommandDefinitions(contributions.map(({ value }) => value))
  registered.push(...contributions.map(({ key }) => key))
  assert.ok(registered.includes("fast"))
  assert.ok(registered.includes("join"))
  assert.ok(registered.includes("leave"))
  const voice = commands.find((command) => command.name === "voice")
  assert.ok(voice)
  const voiceOption = voice.options?.[0]
  assert.ok(voiceOption && "choices" in voiceOption)
  assert.deepEqual(voiceOption.choices?.map((choice) => choice.value), [
    "juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove",
  ])
  const fast = commands.find((command) => command.name === "fast")
  assert.ok(fast)
  assert.equal(fast.options?.[0]?.name, "enabled")
  assert.equal(fast.options?.[0]?.required, false)
})

test("/interrupt and /discard are registered as top-level commands", async (t) => {
  const { bus } = await commandContributions(services())
  t.after(() => bus.close())
  const commands = bus.list(nano.commands).map(({ key }) => key)
  assert.ok(commands.includes("interrupt"))
  assert.ok(commands.includes("discard"))
})

test("/model swap registers its required preset option", async (t) => {
  const { bus } = await commandContributions(services())
  t.after(() => bus.close())
  const model = discordCommandDefinitions(bus.list(nano.commands).map(({ value }) => value)).find((command) => command.name === "model")
  assert.ok(model)
  const swap = model.options?.find((option) => option.name === "swap")
  assert.ok(swap && "options" in swap)
  const preset = swap.options?.[0]
  assert.ok(preset && !("options" in preset))
  assert.equal(preset.name, "preset")
  assert.equal(preset.required, true)
})

test("/compact registers force and snapcompact boolean options", async (t) => {
  const { bus } = await commandContributions(services())
  t.after(() => bus.close())
  const compact = discordCommandDefinitions(bus.list(nano.commands).map(({ value }) => value)).find((command) => command.name === "compact")
  assert.ok(compact)
  assert.deepEqual(compact.options?.map((option) => ({
    name: option.name,
    type: option.type,
    required: option.required,
  })), [
    { name: "force", type: 5, required: false },
    { name: "snapcompact", type: 5, required: false },
  ])
})

test("/interrupt and /discard report when no session is running", async (t) => {
  const { bus, contributions } = await commandContributions(services())
  t.after(() => bus.close())
  const replies: Array<{ content: string; ephemeral: boolean }> = []
  for (const commandName of ["interrupt", "discard"]) {
    const input = interaction(commandName)
    await dispatchDiscordCommand(contributions, input.value as unknown as ChatInputCommandInteraction)
    replies.push(...input.replies)
  }
  assert.match(replies[0]!.content, /not running/)
  assert.match(replies[1]!.content, /not running/)
  assert.ok(replies.every((reply) => reply.ephemeral))
})

test("/status reports runtime state and model stats", async (t) => {
  const { bus, contributions } = await commandContributions(services())
  t.after(() => bus.close())
  const input = interaction("status")
  await dispatchDiscordCommand(contributions, input.value as unknown as ChatInputCommandInteraction)
  assert.match(input.replies[0]!.content, /\*\*state:\*\* resting/)
  assert.match(input.replies[0]!.content, /\*\*model:\*\* model/)
  assert.match(input.replies[0]!.content, /\*\*context size:\*\* 0 tokens/)
  assert.match(input.replies[0]!.content, /\*\*total tokens:\*\* 0/)
  assert.match(input.replies[0]!.content, /\*\*respect prompt cache:\*\* true/)
  assert.match(input.replies[0]!.content, /\*\*thinking:\*\* off/)
  assert.equal(input.replies[0]!.ephemeral, true)
})

test("/fast requires the owner, toggles, accepts explicit values, and appears in model info", async (t) => {
  const commandServices = services()
  const { bus, contributions } = await commandContributions(commandServices)
  t.after(() => bus.close())
  const invoke = async (userId: string, enabled: boolean | null = null, commandName = "fast") => {
    const input = interaction(commandName, userId)
    input.value.options.getBoolean = () => enabled
    await dispatchDiscordCommand(contributions, input.value as unknown as ChatInputCommandInteraction)
    return input.replies[0]!
  }
  assert.equal(commandServices.model.getFastMode(), false)
  const unauthorized = await invoke("stranger")
  assert.equal(commandServices.model.getFastMode(), false)
  assert.match(unauthorized.content, /not authorized/)
  const enabled = await invoke("owner")
  assert.equal(commandServices.model.getFastMode(), true)
  assert.match(enabled.content, /priority/)
  const modelInfo = await invoke("owner", null, "model")
  assert.match(modelInfo.content, /Codex fast mode:\*\* on \(priority\)/)
  assert.match((await invoke("owner")).content, /default/)
  await invoke("owner", true)
  await invoke("owner", true)
  assert.equal(commandServices.model.getFastMode(), true)
  await invoke("owner", false)
  assert.equal(commandServices.model.getFastMode(), false)
})
