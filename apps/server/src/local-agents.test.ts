import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  assertNoDuplicateBridgePorts,
  assertNoDuplicateDiscordTokens,
  buildWorkerEnvironment,
  loadAgentFiles,
  resolveLocalAgents,
} from "./local-agents"

/**
 * Agent files live in the returned directory. Runtime config files go under
 * `cfg/` so the loader does not mistake them for agents.
 */
function fixture(t: test.TestContext, files: Record<string, string> | ((dir: string) => Record<string, string>)): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nano-agents-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.mkdirSync(path.join(directory, "cfg"), { recursive: true })
  for (const [name, contents] of Object.entries(typeof files === "function" ? files(directory) : files)) {
    fs.writeFileSync(path.join(directory, name), contents)
  }
  return directory
}

const options = { controlPort: 4300, repoRoot: "/tmp/nano-review" }

test("one toml file is one complete agent", (t) => {
  const directory = fixture(t, (dir) => ({
    "cfg/base.toml": "[model]\nmodel = \"openai/gpt-5\"\n",
    "cfg/secrets.toml": "[model]\napi_key = \"model-secret\"\n",
    "mira.toml": [
      "name = \"Mira\"",
      "client = \"http://mira-macbook.local:3002\"",
      `config = "${dir}/cfg/base.toml"`,
      `secrets = "${dir}/cfg/secrets.toml"`,
      "",
      "[settings]",
      "RUNNER_MAX_TURNS = 80",
      "",
    ].join("\n"),
  }))

  const [agent] = resolveLocalAgents(loadAgentFiles(directory), options)
  assert.equal(agent?.id, "mira")
  assert.equal(agent?.name, "Mira")
  assert.equal(agent?.client, "http://mira-macbook.local:3002")
  assert.deepEqual(agent?.config, [path.join(directory, "cfg/base.toml")])
  assert.equal(agent?.secrets, path.join(directory, "cfg/secrets.toml"))
  assert.equal(agent?.settings.RUNNER_MAX_TURNS, "80")
})

test("config accepts one path or an ordered list of layers", (t) => {
  const directory = fixture(t, (dir) => ({
    "cfg/base.toml": "[model]\nmodel = \"base\"\n",
    "cfg/override.toml": "[model]\nmodel = \"override\"\n",
    "a.toml": `client = "local"\nconfig = ["${dir}/cfg/base.toml", "${dir}/cfg/override.toml"]\n`,
  }))

  const [agent] = resolveLocalAgents(loadAgentFiles(directory), options)
  assert.deepEqual(agent?.config, [
    path.join(directory, "cfg/base.toml"),
    path.join(directory, "cfg/override.toml"),
  ])
})

test("a config path that does not exist fails startup by name", (t) => {
  const directory = fixture(t, { "a.toml": "client = \"local\"\nconfig = \"/nowhere/config.toml\"\n" })
  assert.throws(() => resolveLocalAgents(loadAgentFiles(directory), options), /config file not found: \/nowhere\/config.toml/)
})

test("local makes the server machine the client", (t) => {
  const directory = fixture(t, {
    "local.toml": "client = \"local\"\nworkspace = \"/tmp\"\n",
  })
  const [agent] = resolveLocalAgents(loadAgentFiles(directory), options)
  assert.equal(agent?.client, "local")
  assert.equal(agent?.workspace, fs.realpathSync.native("/tmp"))
})

test("agent identity, ports, and homes stay isolated", (t) => {
  const directory = fixture(t, {
    "a.toml": "client = \"local\"\nport = 4301\nhome = \"/tmp/shared\"\n",
    "b.toml": "client = \"local\"\nport = 4301\nhome = \"/tmp/shared\"\n",
  })
  assert.throws(() => resolveLocalAgents(loadAgentFiles(directory), options), /share port/)
})

test("worker environment carries host basics and the executor token path, never raw credentials", (t) => {
  const directory = fixture(t, (dir) => ({
    "cfg/base.toml": "[model]\nmodel = \"openai/gpt-5\"\napi_key = \"model-secret\"\n\n[discord]\nbot_token = \"discord-secret\"\n",
    "mira.toml": [
      "client = \"local\"",
      `config = "${dir}/cfg/base.toml"`,
      "",
      "[settings]",
      "RUNNER_MAX_TURNS = 80",
      "",
    ].join("\n"),
  }))

  const [agent] = resolveLocalAgents(loadAgentFiles(directory), options)
  assert.ok(agent)
  const env = buildWorkerEnvironment({
    PATH: "/usr/bin",
    NANO_EXECUTOR_TOKEN_FILE: "/run/agenix/executor-token",
    OPENAI_API_KEY: "inherited",
    SHELL: "/bin/bash",
  }, agent)

  assert.equal(env.NANO_AGENT_ID, "mira")
  assert.equal(env.PORT, "4301")
  assert.equal(env.RUNNER_MAX_TURNS, "80")
  assert.equal(env.PATH, "/usr/bin")
  assert.equal(env.NANO_EXECUTOR_TOKEN_FILE, "/run/agenix/executor-token")
  // Config travels as files on argv. Nothing from [model] or [discord] may
  // reach the environment, because the agent's own bash tool inherits it.
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.MODEL, undefined)
  assert.equal(env.DISCORD_BOT_TOKEN, undefined)
  assert.equal(env.SHELL, undefined)
})

test("unknown and reserved toml settings fail startup", (t) => {
  const unknownKey = fixture(t, { "a.toml": "client = \"local\"\nmodel = \"gpt-5\"\n" })
  assert.throws(() => loadAgentFiles(unknownKey), /unknown keys: model/)

  const lowercase = fixture(t, { "a.toml": "client = \"local\"\n\n[settings]\nrunner_max_turns = 80\n" })
  assert.throws(() => loadAgentFiles(lowercase), /uppercase runtime setting name/)

  const reserved = fixture(t, { "a.toml": "client = \"local\"\n\n[settings]\nNANO_CLIENT = \"local\"\n" })
  assert.throws(() => loadAgentFiles(reserved), /managed by the server/)

  const configVar = fixture(t, { "a.toml": "client = \"local\"\n\n[settings]\nNANO_CONFIG = \"/etc/nano/config.toml\"\n" })
  assert.throws(() => loadAgentFiles(configVar), /managed by the server/)

  const executorToken = fixture(t, { "a.toml": "client = \"local\"\n\n[settings]\nNANO_EXECUTOR_TOKEN_FILE = \"/tmp/token\"\n" })
  assert.throws(() => loadAgentFiles(executorToken), /managed by the server/)
})

test("malformed toml names the file", (t) => {
  const directory = fixture(t, { "broken.toml": "client = \n" })
  assert.throws(() => loadAgentFiles(directory), /broken\.toml: invalid toml/)
})

test("yaml files are no longer discovered", (t) => {
  const directory = fixture(t, { "a.yaml": "client: local\n" })
  assert.throws(() => loadAgentFiles(directory), /no agent toml files found/)
})

test("one discord bot cannot be driven by two agents", (t) => {
  const directory = fixture(t, (dir) => ({
    "cfg/shared.toml": "[discord]\nbot_token = \"same-token\"\n",
    "a.toml": `client = "local"\nconfig = "${dir}/cfg/shared.toml"\n`,
    "b.toml": `client = "local"\nconfig = "${dir}/cfg/shared.toml"\n`,
  }))
  const agents = resolveLocalAgents(loadAgentFiles(directory), options)
  assert.throws(() => assertNoDuplicateDiscordTokens(agents), /share \[discord\]\.bot_token/)
})

test("a discord token declared only in secrets is still seen", (t) => {
  const directory = fixture(t, (dir) => ({
    "cfg/secrets.toml": "[discord]\nbot_token = \"secret-token\"\n",
    "a.toml": `client = "local"\nsecrets = "${dir}/cfg/secrets.toml"\n`,
    "b.toml": `client = "local"\nsecrets = "${dir}/cfg/secrets.toml"\n`,
  }))
  const agents = resolveLocalAgents(loadAgentFiles(directory), options)
  assert.throws(() => assertNoDuplicateDiscordTokens(agents), /share \[discord\]\.bot_token/)
})

test("bridge ports cannot collide with the control plane or a worker", (t) => {
  const directory = fixture(t, {
    "a.toml": "client = \"local\"\nport = 4301\n\n[settings]\nANTIGRAVITY_BRIDGE_ENABLED = true\nANTIGRAVITY_BRIDGE_PORT = 4400\n",
    "b.toml": "client = \"local\"\nport = 4302\n\n[settings]\nCODEX_BRIDGE_ENABLED = true\nCODEX_BRIDGE_PORT = 4400\n",
  })
  const agents = resolveLocalAgents(loadAgentFiles(directory), options)
  assert.throws(() => assertNoDuplicateBridgePorts(agents, 4300), /bridges share port 4400/)
})
