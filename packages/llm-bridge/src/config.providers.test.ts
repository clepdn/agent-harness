import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { addSavedAuthProviders, loadConfig } from "./config"
import { resolveAuthPath } from "./oauth-login"

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bridge-provider-restore-"))
}

function writeAuthFile(filePath: string, contents: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(contents))
}

test("saved auth files restore only the matching missing provider", () => {
  const state = tempDir()
  const anthropicPath = path.join(state, "auth", "anthropic.json")
  const codexPath = path.join(state, "auth", "codex.json")
  try {
    assert.deepEqual(
      addSavedAuthProviders({}, { stateDirectory: state, codexAuthPath: codexPath }),
      {},
    )

    writeAuthFile(anthropicPath, {
      anthropic: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 3_600_000 },
    })

    const onlyAnthropic = addSavedAuthProviders({}, { stateDirectory: state, codexAuthPath: codexPath })
    assert.deepEqual(onlyAnthropic, { "anthropic-oauth": { auth_path: anthropicPath } })

    writeAuthFile(codexPath, {
      tokens: { access_token: "access", refresh_token: "refresh", account_id: "account" },
    })
    const both = addSavedAuthProviders({}, { stateDirectory: state, codexAuthPath: codexPath })
    assert.deepEqual(both, {
      "anthropic-oauth": { auth_path: anthropicPath },
      codex: { auth_path: codexPath },
    })
  } finally {
    fs.rmSync(state, { recursive: true, force: true })
  }
})

test("explicit provider entries win over saved auth discovery", () => {
  const state = tempDir()
  const anthropicPath = path.join(state, "auth", "anthropic.json")
  const codexPath = path.join(state, "auth", "codex.json")
  try {
    writeAuthFile(anthropicPath, { anthropic: { type: "oauth", refresh: "refresh" } })
    writeAuthFile(codexPath, { tokens: { access_token: "access" } })
    const explicit = {
      "anthropic-oauth": { auth_path: "/etc/coral/anthropic.json", base_url: "https://anthropic.example" },
      codex: { auth_path: "/etc/coral/codex.json", model: "custom-codex" },
      umans: { base_url: "https://api.example", api_key_file: "/run/agenix/umans" },
    }

    assert.deepEqual(
      addSavedAuthProviders(explicit, { stateDirectory: state, codexAuthPath: codexPath }),
      explicit,
    )
  } finally {
    fs.rmSync(state, { recursive: true, force: true })
  }
})

test("startup restoration and admin login resolve Codex to the same file", () => {
  const state = tempDir()
  const codexPath = path.join(state, ".codex", "auth.json")
  const previous = process.env.CODEX_AUTH_PATH
  try {
    writeAuthFile(codexPath, { tokens: { access_token: "access", refresh_token: "refresh" } })
    process.env.CODEX_AUTH_PATH = codexPath

    const restored = addSavedAuthProviders({}, { stateDirectory: state })
    const adminPath = resolveAuthPath(
      { port: 4040, host: "127.0.0.1", providers: {}, models: {} },
      "codex",
    )
    assert.equal(restored.codex?.auth_path, adminPath)
    assert.equal(adminPath, codexPath)
  } finally {
    if (previous === undefined) delete process.env.CODEX_AUTH_PATH
    else process.env.CODEX_AUTH_PATH = previous
    fs.rmSync(state, { recursive: true, force: true })
  }
})

test("loadConfig restores saved providers before rejecting an empty config", () => {
  const state = tempDir()
  const anthropicPath = path.join(state, "auth", "anthropic.json")
  const codexPath = path.join(state, ".codex", "auth.json")
  const previousState = process.env.STATE_DIRECTORY
  const previousBridgeState = process.env.BRIDGE_STATE_DIR
  const previousCodex = process.env.CODEX_AUTH_PATH
  const previousProviders = process.env.BRIDGE_PROVIDERS
  const previousArgv = process.argv
  try {
    writeAuthFile(anthropicPath, { anthropic: { type: "oauth", refresh: "refresh" } })
    writeAuthFile(codexPath, { tokens: { access_token: "access" } })
    process.env.STATE_DIRECTORY = state
    delete process.env.BRIDGE_STATE_DIR
    process.env.CODEX_AUTH_PATH = codexPath
    delete process.env.BRIDGE_PROVIDERS
    process.argv = previousArgv.slice(0, 2)

    const config = loadConfig()
    assert.deepEqual(config.providers, {
      "anthropic-oauth": { auth_path: anthropicPath },
      codex: { auth_path: codexPath },
    })
  } finally {
    process.argv = previousArgv
    if (previousState === undefined) delete process.env.STATE_DIRECTORY
    else process.env.STATE_DIRECTORY = previousState
    if (previousBridgeState === undefined) delete process.env.BRIDGE_STATE_DIR
    else process.env.BRIDGE_STATE_DIR = previousBridgeState
    if (previousCodex === undefined) delete process.env.CODEX_AUTH_PATH
    else process.env.CODEX_AUTH_PATH = previousCodex
    if (previousProviders === undefined) delete process.env.BRIDGE_PROVIDERS
    else process.env.BRIDGE_PROVIDERS = previousProviders
    fs.rmSync(state, { recursive: true, force: true })
  }
})

test("loadConfig does not restore home credentials without an explicit state root", () => {
  const home = tempDir()
  const codexPath = path.join(home, ".codex", "auth.json")
  const previousHome = process.env.HOME
  const previousState = process.env.STATE_DIRECTORY
  const previousBridgeState = process.env.BRIDGE_STATE_DIR
  const previousCodex = process.env.CODEX_AUTH_PATH
  const previousProviders = process.env.BRIDGE_PROVIDERS
  const previousArgv = process.argv
  try {
    writeAuthFile(codexPath, { tokens: { access_token: "home-access" } })
    process.env.HOME = home
    delete process.env.STATE_DIRECTORY
    delete process.env.BRIDGE_STATE_DIR
    delete process.env.CODEX_AUTH_PATH
    process.env.BRIDGE_PROVIDERS = JSON.stringify({ umans: { base_url: "https://api.example" } })
    process.argv = previousArgv.slice(0, 2)

    const config = loadConfig()
    assert.deepEqual(config.providers, { umans: { base_url: "https://api.example" } })
  } finally {
    process.argv = previousArgv
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousState === undefined) delete process.env.STATE_DIRECTORY
    else process.env.STATE_DIRECTORY = previousState
    if (previousBridgeState === undefined) delete process.env.BRIDGE_STATE_DIR
    else process.env.BRIDGE_STATE_DIR = previousBridgeState
    if (previousCodex === undefined) delete process.env.CODEX_AUTH_PATH
    else process.env.CODEX_AUTH_PATH = previousCodex
    if (previousProviders === undefined) delete process.env.BRIDGE_PROVIDERS
    else process.env.BRIDGE_PROVIDERS = previousProviders
    fs.rmSync(home, { recursive: true, force: true })
  }
})
