import assert from "node:assert/strict"
import test from "node:test"
import type { ChatInputCommandInteraction, Client } from "discord.js"
import { config } from "../config"
import { getCodexFastMode, setCodexFastMode } from "../codex-fast-mode"
import { handleInteraction, registerSlashCommands } from "./slash-commands"

test("voice commands are registered alongside /fast", async () => {
  let commands: any[] = []
  await registerSlashCommands({
    application: { commands: { set: async (value: any[]) => { commands = value } } },
  } as unknown as Client)
  const command = commands.find((entry) => entry.name === "fast")
  assert.ok(command)
  assert.equal(command.options[0].name, "enabled")
  assert.equal(command.options[0].type, 5)
  assert.equal(command.options[0].required, false)
  assert.ok(commands.some((entry) => entry.name === "join"))
  assert.ok(commands.some((entry) => entry.name === "leave"))
  const voice = commands.find((entry) => entry.name === "voice")
  assert.ok(voice)
  assert.deepEqual(voice.options[0].choices.map((choice: { value: string }) => choice.value), [
    "juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove",
  ])
})

test("/interrupt and /discard are registered as top-level commands", async () => {
  let commands: any[] = []
  await registerSlashCommands({
    application: { commands: { set: async (value: any[]) => { commands = value } } },
  } as unknown as Client)
  assert.ok(commands.some((entry) => entry.name === "interrupt"))
  assert.ok(commands.some((entry) => entry.name === "discard"))
})

test("/compact registers force and snapcompact boolean options", async () => {
  let commands: any[] = []
  await registerSlashCommands({
    application: { commands: { set: async (value: any[]) => { commands = value } } },
  } as unknown as Client)
  const compact = commands.find((entry) => entry.name === "compact")
  assert.ok(compact)
  assert.deepEqual(
    compact.options.map((option: { name: string; type: number; required?: boolean }) => ({
      name: option.name,
      type: option.type,
      required: option.required,
    })),
    [
      { name: "force", type: 5, required: false },
      { name: "snapcompact", type: 5, required: false },
    ],
  )
})

test("/interrupt and /discard report when no session is running", async (t) => {
  const previousOwner = config.discord.owner_id
  t.after(() => { config.discord.owner_id = previousOwner })
  config.discord.owner_id = "owner"
  const replies: { content: string; ephemeral: boolean }[] = []
  for (const commandName of ["interrupt", "discard"]) {
    await handleInteraction({
      user: { id: "owner" },
      commandName,
      options: { getSubcommand: () => null },
      reply: async (reply: { content: string; ephemeral: boolean }) => { replies.push(reply) },
    } as unknown as ChatInputCommandInteraction)
  }
  assert.match(replies[0]!.content, /not running/)
  assert.match(replies[1]!.content, /not running/)
  assert.ok(replies.every((reply) => reply.ephemeral))
})

test("/status includes frontend model stats only when the frontend is enabled", async (t) => {
  const previousOwner = config.discord.owner_id
  const previousFrontend = config.frontend.enable
  t.after(() => {
    config.discord.owner_id = previousOwner
    config.frontend.enable = previousFrontend
  })
  config.discord.owner_id = "owner"

  const replies: { content: string; ephemeral: boolean }[] = []
  const invoke = () => handleInteraction({
    user: { id: "owner" },
    commandName: "status",
    options: { getSubcommand: () => null },
    reply: async (reply: { content: string; ephemeral: boolean }) => { replies.push(reply) },
  } as unknown as ChatInputCommandInteraction)

  config.frontend.enable = false
  await invoke()
  assert.doesNotMatch(replies.at(-1)!.content, /\*\*frontend:\*\*/)

  config.frontend.enable = true
  await invoke()
  const content = replies.at(-1)!.content
  assert.match(content, /\*\*frontend:\*\*/)
  assert.match(content, /- \*\*state:\*\* resting/)
  assert.match(content, /- \*\*model:\*\*/)
  assert.match(content, /- \*\*context size:\*\* 0 tokens/)
  assert.match(content, /- \*\*total tokens:\*\* 0/)
  assert.match(content, /- \*\*respect prompt cache:\*\*/)
  assert.match(content, /- \*\*thinking:\*\*/)
  assert.equal(replies.at(-1)!.ephemeral, true)
})

test("/fast requires the owner, toggles, accepts explicit values, and appears in model info", async (t) => {
  const previousOwner = config.discord.owner_id
  const previousMode = getCodexFastMode()
  t.after(() => {
    config.discord.owner_id = previousOwner
    setCodexFastMode(previousMode)
  })
  config.discord.owner_id = "owner"
  setCodexFastMode(false)
  const replies: { content: string; ephemeral: boolean }[] = []
  const invoke = (userId: string, enabled: boolean | null = null, commandName = "fast") =>
    handleInteraction({
      user: { id: userId },
      commandName,
      options: { getSubcommand: () => commandName === "model" ? "info" : null, getBoolean: () => enabled },
      reply: async (reply: { content: string; ephemeral: boolean }) => { replies.push(reply) },
    } as unknown as ChatInputCommandInteraction)

  await invoke("stranger")
  assert.equal(getCodexFastMode(), false)
  assert.match(replies.at(-1)!.content, /not authorized/)
  await invoke("owner")
  assert.equal(getCodexFastMode(), true)
  assert.match(replies.at(-1)!.content, /priority/)
  await invoke("owner", null, "model")
  assert.match(replies.at(-1)!.content, /Codex fast mode:\*\* on \(priority\)/)
  await invoke("owner")
  assert.equal(getCodexFastMode(), false)
  assert.match(replies.at(-1)!.content, /default/)
  await invoke("owner", true)
  await invoke("owner", true)
  assert.equal(getCodexFastMode(), true)
  await invoke("owner", false)
  await invoke("owner", false)
  assert.equal(getCodexFastMode(), false)
  assert.ok(replies.every((reply) => reply.ephemeral))
})
