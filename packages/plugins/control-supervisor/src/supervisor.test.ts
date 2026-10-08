import assert from "node:assert/strict"
import test from "node:test"
import { buildWorkerEnvironment, matchesWorkerIdentity } from "./supervisor.js"
import type { ResolvedLocalAgent } from "@nano/control-api"

const agent: ResolvedLocalAgent = {
  id: "mira",
  name: "Mira",
  port: 4301,
  home: "/tmp/mira",
  client: "local",
  config: [],
  settings: { RUNNER_MAX_TURNS: "80" },
  source: "/tmp/mira.json",
}

test("worker environment carries safe host settings and no credentials", () => {
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
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.SHELL, undefined)
})

test("worker health must match the supervised agent and process instance", () => {
  assert.equal(matchesWorkerIdentity({ agentId: "mira", instanceId: "one" }, "mira", "one"), true)
  assert.equal(matchesWorkerIdentity({ agentId: "other", instanceId: "one" }, "mira", "one"), false)
  assert.equal(matchesWorkerIdentity({ agentId: "mira", instanceId: "stale" }, "mira", "one"), false)
})
