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
} from "./local-agents.js"

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

test("one JSON file is one complete agent", (t) => {
  const directory = fixture(t, (dir) => ({
    "cfg/base.json": JSON.stringify({ "model": { "model": "openai/gpt-5" } }),
    "cfg/secrets.json": JSON.stringify({ "model": { "api_key": "model-secret" } }),
    "mira.json": JSON.stringify({ "name": "Mira", "client": "http://mira-macbook.local:3002", "config": `${dir}/cfg/base.json`, "secrets": `${dir}/cfg/secrets.json`, "settings": { "RUNNER_MAX_TURNS": 80 } }),
  }))

  const [agent] = resolveLocalAgents(loadAgentFiles(directory), options)
  assert.equal(agent?.id, "mira")
  assert.equal(agent?.name, "Mira")
  assert.equal(agent?.client, "http://mira-macbook.local:3002")
  assert.deepEqual(agent?.config, [path.join(directory, "cfg/base.json")])
  assert.equal(agent?.secrets, path.join(directory, "cfg/secrets.json"))
  assert.equal(agent?.settings.RUNNER_MAX_TURNS, "80")
})

test("config accepts one path or an ordered list of layers", (t) => {
  const directory = fixture(t, (dir) => ({
    "cfg/base.json": JSON.stringify({ "model": { "model": "base" } }),
    "cfg/override.json": JSON.stringify({ "model": { "model": "override" } }),
    "a.json": JSON.stringify({ "client": "local", "config": [`${dir}/cfg/base.json`, `${dir}/cfg/override.json`] }),
  }))

  const [agent] = resolveLocalAgents(loadAgentFiles(directory), options)
  assert.deepEqual(agent?.config, [
    path.join(directory, "cfg/base.json"),
    path.join(directory, "cfg/override.json"),
  ])
})

test("a config path that does not exist fails startup by name", (t) => {
  const directory = fixture(t, { "a.json": JSON.stringify({ "client": "local", "config": "/nowhere/config.json" }) })
  assert.throws(() => resolveLocalAgents(loadAgentFiles(directory), options), /config file not found: \/nowhere\/config.json/)
})

test("local makes the server machine the client", (t) => {
  const directory = fixture(t, {
    "local.json": JSON.stringify({ "client": "local", "workspace": "/tmp" }),
  })
  const [agent] = resolveLocalAgents(loadAgentFiles(directory), options)
  assert.equal(agent?.client, "local")
  assert.equal(agent?.workspace, fs.realpathSync.native("/tmp"))
})

test("agent identity, ports, and homes stay isolated", (t) => {
  const directory = fixture(t, {
    "a.json": JSON.stringify({ "client": "local", "port": 4301, "home": "/tmp/shared" }),
    "b.json": JSON.stringify({ "client": "local", "port": 4301, "home": "/tmp/shared" }),
  })
  assert.throws(() => resolveLocalAgents(loadAgentFiles(directory), options), /share port/)
})

test("worker environment carries host basics and the executor token path, never raw credentials", (t) => {
  const directory = fixture(t, (dir) => ({
    "cfg/base.json": JSON.stringify({ "model": { "model": "openai/gpt-5", "api_key": "model-secret" }, "discord": { "bot_token": "discord-secret" } }),
    "mira.json": JSON.stringify({ "client": "local", "config": `${dir}/cfg/base.json`, "settings": { "RUNNER_MAX_TURNS": 80 } }),
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

test("unknown and reserved JSON settings fail startup", (t) => {
  const unknownKey = fixture(t, { "a.json": JSON.stringify({ "client": "local", "model": "gpt-5" }) })
  assert.throws(() => loadAgentFiles(unknownKey), /unknown keys: model/)

  const lowercase = fixture(t, { "a.json": JSON.stringify({ "client": "local", "settings": { "runner_max_turns": 80 } }) })
  assert.throws(() => loadAgentFiles(lowercase), /uppercase runtime setting name/)

  const reserved = fixture(t, { "a.json": JSON.stringify({ "client": "local", "settings": { "NANO_CLIENT": "local" } }) })
  assert.throws(() => loadAgentFiles(reserved), /managed by the server/)

  const configVar = fixture(t, { "a.json": JSON.stringify({ "client": "local", "settings": { "NANO_CONFIG": "/etc/nano/config.json" } }) })
  assert.throws(() => loadAgentFiles(configVar), /managed by the server/)

  const executorToken = fixture(t, { "a.json": JSON.stringify({ "client": "local", "settings": { "NANO_EXECUTOR_TOKEN_FILE": "/tmp/token" } }) })
  assert.throws(() => loadAgentFiles(executorToken), /managed by the server/)
})

test("malformed JSON names the file", (t) => {
  const directory = fixture(t, { "broken.json": "{\"client\":" })
  assert.throws(() => loadAgentFiles(directory), /broken\.json: invalid JSON/)
})

test("yaml files are no longer discovered", (t) => {
  const directory = fixture(t, { "a.yaml": "client: local\n" })
  assert.throws(() => loadAgentFiles(directory), /no agent JSON files found/)
})

test("discovery skips TOML, Nix source files, and JSON examples", (t) => {
  const directory = fixture(t, {
    "old.toml": 'client = "local"',
    "source.nix": '{ client = "local"; }',
    "ignored.example.json": "invalid example",
    "active.json": JSON.stringify({ client: "local" }),
  })
  assert.deepEqual(resolveLocalAgents(loadAgentFiles(directory), options).map(agent => agent.id), ["active"])
})

test("one discord bot cannot be driven by two agents", (t) => {
  const directory = fixture(t, (dir) => ({
    "cfg/shared.json": JSON.stringify({ "discord": { "bot_token": "same-token" } }),
    "a.json": JSON.stringify({ "client": "local", "config": `${dir}/cfg/shared.json` }),
    "b.json": JSON.stringify({ "client": "local", "config": `${dir}/cfg/shared.json` }),
  }))
  const agents = resolveLocalAgents(loadAgentFiles(directory), options)
  assert.throws(() => assertNoDuplicateDiscordTokens(agents), /share \[discord\]\.bot_token/)
})

test("a discord token declared only in secrets is still seen", (t) => {
  const directory = fixture(t, (dir) => ({
    "cfg/secrets.json": JSON.stringify({ "discord": { "bot_token": "secret-token" } }),
    "a.json": JSON.stringify({ "client": "local", "secrets": `${dir}/cfg/secrets.json` }),
    "b.json": JSON.stringify({ "client": "local", "secrets": `${dir}/cfg/secrets.json` }),
  }))
  const agents = resolveLocalAgents(loadAgentFiles(directory), options)
  assert.throws(() => assertNoDuplicateDiscordTokens(agents), /share \[discord\]\.bot_token/)
})

test("bridge ports cannot collide with the control plane or a worker", (t) => {
  const directory = fixture(t, {
    "a.json": JSON.stringify({ "client": "local", "port": 4301, "settings": { "ANTIGRAVITY_BRIDGE_ENABLED": true, "ANTIGRAVITY_BRIDGE_PORT": 4400 } }),
    "b.json": JSON.stringify({ "client": "local", "port": 4302, "settings": { "CODEX_BRIDGE_ENABLED": true, "CODEX_BRIDGE_PORT": 4400 } }),
  })
  const agents = resolveLocalAgents(loadAgentFiles(directory), options)
  assert.throws(() => assertNoDuplicateBridgePorts(agents, 4300), /bridges share port 4400/)
})
