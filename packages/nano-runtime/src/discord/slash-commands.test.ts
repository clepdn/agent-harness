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
