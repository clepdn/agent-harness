/**
 * Shim mode: run the harness from a local checkout instead of the nix store.
 *
 * At startup, index.ts calls tryShim() before main(). If ~/.harness.json
 * exists with shim.enable = true and shim.harness_path = "...", the shim spawns
 * the local harness as a child process and proxies stdio + signals.
 *
 * Exit semantics:
 *   - child exits 0  →  shim exits 0 (clean shutdown)
 *   - child exits non-zero  →  shim sets NANO_SHIM_FAILED and returns,
 *     letting the caller fall through to normal main() (safe mode)
 *   - no shim config  →  returns immediately (normal startup)
 */

import { existsSync, readFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { isConfigObject, parseConfig } from "@nano/config"

/** Environment variable set when the shim child fails and we enter safe mode. */
export const SHIM_FAILED_ENV = "NANO_SHIM_FAILED"

interface ShimConfig {
  enable: boolean
  harnessPath: string
  configPath?: string
}

function parseShimConfig(configPath: string): ShimConfig | null {
  if (!existsSync(configPath)) return null

  try {
    const { shim } = parseConfig(readFileSync(configPath, "utf8"))
    if (!isConfigObject(shim) || shim.enable !== true ||
        typeof shim.harness_path !== "string" || !shim.harness_path.trim()) return null
    const override = typeof shim.config_path === "string" ? shim.config_path.trim() : ""
    return { enable: true, harnessPath: shim.harness_path.trim(), ...(override ? { configPath: override } : {}) }
  } catch {
    return null
  }
}

/**
 * Check for ~/.harness.json and, if shim mode is enabled, spawn the local
 * harness as a child process. Blocks until the child exits.
 *
 * Returns normally only if:
 *   - no shim config was found (normal startup), or
 *   - the child exited non-zero (safe mode — sets NANO_SHIM_FAILED)
 *
 * Calls process.exit(0) if the child exits cleanly.
 */
export async function tryShim(): Promise<void> {
  // Prevent re-entry: if we're already running inside a shim, don't spawn again.
  if (process.env.NANO_SHIM_ACTIVE) return

  const homeDir = process.env.HOME ?? "/home/nano"
  const shimConfigPath = join(homeDir, ".harness.json")

  const shimConfig = parseShimConfig(shimConfigPath)
  if (!shimConfig) return

  const { harnessPath, configPath } = shimConfig
  const tsxPath = join(harnessPath, "node_modules", ".bin", "tsx")
  const indexPath = join(harnessPath, "packages", "nano-runtime", "src", "index.ts")

  if (!existsSync(tsxPath) || !existsSync(indexPath)) {
    console.error(`[shim] harness path missing required files: ${harnessPath}`)
    console.error(`[shim] expected tsx at ${tsxPath} and index at ${indexPath}`)
    process.env[SHIM_FAILED_ENV] = "true"
    return
  }

  // Build child args: forward service args but replace --config if config_path is set.
  // Secrets are always passed through from the service args (never overridden).
  const childArgs = [...process.argv.slice(2)]
  if (configPath) {
    const configIdx = childArgs.indexOf("--config")
    if (configIdx >= 0) {
      childArgs[configIdx + 1] = configPath
    } else {
      childArgs.push("--config", configPath)
    }
    console.log(`[shim] overriding config with ${configPath}`)
  }

  console.log(`[shim] starting local harness from ${harnessPath}`)

  const child = spawn(process.execPath, [tsxPath, indexPath, ...childArgs], {
    stdio: "inherit",
    env: { ...process.env, NANO_SHIM_ACTIVE: "true" },
  })

  // Forward signals to child
  const forward = (sig: NodeJS.Signals) => {
    if (!child.killed) child.kill(sig)
  }
  process.on("SIGTERM", () => forward("SIGTERM"))
  process.on("SIGINT", () => forward("SIGINT"))

  await new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      if (code === 0) {
        console.log("[shim] child exited cleanly")
        process.exit(0)
      }
      console.warn(`[shim] child exited with code ${code} signal ${signal}, entering safe mode`)
      process.env[SHIM_FAILED_ENV] = "true"
      resolve()
    })

    child.on("error", (err) => {
      console.error("[shim] failed to spawn child:", err)
      process.env[SHIM_FAILED_ENV] = "true"
      resolve()
    })
  })
}
