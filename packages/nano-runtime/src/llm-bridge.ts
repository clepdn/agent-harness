/**
 * LLM Bridge — spawns the llm-bridge package as a child process.
 *
 * The bridge is our own OpenRouter. It accepts standard OpenAI format
 * requests, routes to the best available provider (pi-ai registry +
 * custom providers), and returns standard OpenAI format responses.
 *
 * Configured via [llm_bridge] in the TOML config:
 *
 *   [llm_bridge]
 *   enabled = true
 *   host = "127.0.0.1"
 *   port = 4040
 *
 *   [[llm_bridge.providers]]
 *   name = "umans"
 *   api_key = "..."
 *   base_url = "https://api.code.umans.ai/v1"
 *
 *   [[llm_bridge.providers]]
 *   name = "anthropic-oauth"
 *   # Path to a pi-ai auth.json holding the Claude Pro/Max OAuth credential.
 *   # Tokens are read, refreshed on expiry, and rotated back in place — the
 *   # same file/format pi uses.
 *   auth_path = "~/.pi/agent/auth.json"
 *
 * Claude models are discovered dynamically from Anthropic's /v1/models — none
 * are hardcoded.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "./config"

let bridgeProcess: ChildProcess | null = null

function getRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "package.json"))) return dir
    dir = path.dirname(dir)
  }
  return process.cwd()
}

export async function startLlmBridge(): Promise<void> {
  const cfg = config.llm_bridge
  if (!cfg.enabled) return

  const providerNames = Object.keys(cfg.providers)
  if (providerNames.length === 0) {
    console.warn("[llm-bridge] enabled=true but no providers configured — skipping")
    return
  }

  const repoRoot = getRepoRoot()
  const bridgeEntry = path.join(repoRoot, "packages", "llm-bridge", "src", "index.ts")
  const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx")

  // Pass providers as JSON env var (object keyed by name)
  const providersJson = JSON.stringify(cfg.providers)

  const env: Record<string, string> = {
    ...process.env,
    BRIDGE_PORT: String(cfg.port),
    BRIDGE_HOST: cfg.host,
    BRIDGE_PROVIDERS: providersJson,
  }

  console.log(`[llm-bridge] starting on ${cfg.host}:${cfg.port} (${providerNames.length} providers: ${providerNames.join(", ")})`)

  bridgeProcess = spawn(tsxBin, [bridgeEntry], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: repoRoot,
    detached: false,
  })

  bridgeProcess.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString().trim()
    if (lines) console.log(`[llm-bridge] ${lines}`)
  })

  bridgeProcess.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString().trim()
    if (lines) console.error(`[llm-bridge] ${lines}`)
  })

  bridgeProcess.on("exit", (code, signal) => {
    console.log(`[llm-bridge] process exited (code=${code}, signal=${signal})`)
    bridgeProcess = null
  })

  bridgeProcess.on("error", (err) => {
    console.error(`[llm-bridge] failed to start:`, err)
    bridgeProcess = null
  })

  await new Promise((resolve) => setTimeout(resolve, 1000))
}

export async function stopLlmBridge(): Promise<void> {
  if (!bridgeProcess) return

  console.log("[llm-bridge] stopping...")
  bridgeProcess.kill("SIGTERM")

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (bridgeProcess) bridgeProcess.kill("SIGKILL")
      resolve()
    }, 5000)

    bridgeProcess?.on("exit", () => {
      clearTimeout(timeout)
      resolve()
    })
  })

  bridgeProcess = null
  console.log("[llm-bridge] stopped")
}
