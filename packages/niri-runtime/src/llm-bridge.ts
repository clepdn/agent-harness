/**
 * LLM Bridge — spawns the llm-bridge package as a child process.
 *
 * All AI requests go through the bridge. It runs locally and the harness
 * points model.base_url at it.
 *
 * Configured via [llm_bridge] in the TOML config:
 *
 *   [llm_bridge]
 *   enabled = true
 *   host = "127.0.0.1"
 *   port = 4040
 *   provider = "openai"
 *   model = "umans-glm-5.2"
 *   api_key = "..."        # upstream API key
 *   base_url = "https://api.code.umans.ai/v1"
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

  if (!cfg.base_url || !cfg.api_key) {
    console.warn("[llm-bridge] enabled=true but api_key or base_url not set — skipping")
    return
  }

  const repoRoot = getRepoRoot()
  const bridgeEntry = path.join(repoRoot, "packages", "llm-bridge", "src", "index.ts")
  const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx")

  const env: Record<string, string> = {
    ...process.env,
    BRIDGE_PORT: String(cfg.port),
    BRIDGE_HOST: cfg.host,
    ...(cfg.api_key ? { BRIDGE_API_KEY: cfg.api_key } : {}),
    ...(cfg.base_url ? { BRIDGE_BASE_URL: cfg.base_url } : {}),
  }

  console.log(`[llm-bridge] starting on ${cfg.host}:${cfg.port} (upstream=${cfg.base_url})`)

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
