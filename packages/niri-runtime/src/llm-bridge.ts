/**
 * LLM Bridge — spawns the llm-bridge package as a child process.
 *
 * The bridge is an OpenAI-compatible HTTP proxy backed by pi-ai. It runs
 * locally (default localhost:4040) and the harness can point model.base_url
 * at it to route all LLM traffic through pi-ai's provider abstraction.
 *
 * Env vars consumed:
 *   LLM_BRIDGE_ENABLED    — "true" to enable (default: disabled)
 *   LLM_BRIDGE_PORT      — port to listen on (default: 4040)
 *   LLM_BRIDGE_PROVIDER  — upstream provider (e.g. "openai", "openrouter")
 *   LLM_BRIDGE_MODEL     — upstream model id (e.g. "umans-glm-5.2")
 *   LLM_BRIDGE_API_KEY   — upstream API key
 *   LLM_BRIDGE_BASE_URL  — upstream base URL (e.g. "https://api.code.umans.ai/v1")
 *   LLM_BRIDGE_OAUTH_REFRESH_TOKEN — Anthropic OAuth refresh token (optional)
 *
 * When enabled, the harness config should set:
 *   [model]
 *   base_url = "http://localhost:4040/v1"
 *   api_key = "bridge"  # or a UUID if bridge auth is configured
 */

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

let bridgeProcess: ChildProcess | null = null

function getRepoRoot(): string {
  // Walk up from this file to find the repo root (where package.json lives)
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "package.json"))) return dir
    dir = path.dirname(dir)
  }
  return process.cwd()
}

export async function startLlmBridge(): Promise<void> {
  const enabled = process.env.LLM_BRIDGE_ENABLED === "true"
  if (!enabled) {
    return
  }

  const port = process.env.LLM_BRIDGE_PORT || process.env.BRIDGE_PORT || "4040"
  const provider = process.env.LLM_BRIDGE_PROVIDER || process.env.BRIDGE_PROVIDER
  const model = process.env.LLM_BRIDGE_MODEL || process.env.BRIDGE_MODEL
  const apiKey = process.env.LLM_BRIDGE_API_KEY || process.env.BRIDGE_API_KEY
  const baseUrl = process.env.LLM_BRIDGE_BASE_URL || process.env.BRIDGE_BASE_URL

  if (!provider || !model) {
    console.warn("[llm-bridge] LLM_BRIDGE_ENABLED=true but LLM_BRIDGE_PROVIDER or LLM_BRIDGE_MODEL not set — skipping")
    return
  }

  const repoRoot = getRepoRoot()
  const bridgeEntry = path.join(repoRoot, "packages", "llm-bridge", "src", "index.ts")

  // Resolve tsx binary
  const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx")

  const env: Record<string, string> = {
    ...process.env,
    BRIDGE_PORT: port,
    BRIDGE_HOST: "127.0.0.1",
    BRIDGE_PROVIDER: provider,
    BRIDGE_MODEL: model,
    ...(apiKey ? { BRIDGE_API_KEY: apiKey } : {}),
    ...(baseUrl ? { BRIDGE_BASE_URL: baseUrl } : {}),
  }

  console.log(`[llm-bridge] starting on port ${port} (provider=${provider}, model=${model})`)

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

  // Wait a moment for the bridge to start listening
  await new Promise((resolve) => setTimeout(resolve, 1000))
}

export async function stopLlmBridge(): Promise<void> {
  if (!bridgeProcess) return

  console.log("[llm-bridge] stopping...")
  bridgeProcess.kill("SIGTERM")

  // Wait up to 5 seconds for graceful shutdown
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (bridgeProcess) {
        bridgeProcess.kill("SIGKILL")
      }
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
