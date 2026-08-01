import os from "node:os"
import path from "path"
import { fileURLToPath } from "node:url"
import { config } from "./config"

/**
 * Stable id used by the control plane to distinguish this worker.
 *
 * The control plane assigns it explicitly; a standalone run falls back to
 * `[agent].name`, so one config file identifies the same agent either way.
 */
export const AGENT_ID = (process.env.NIRI_AGENT_ID ?? process.env.AGENT_ID ?? config.agent.name).trim() || "niri"

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

/**
 * Resolve durable agent state without ever deriving the default from the
 * executable/source location. Managed workers set NIRI_HOME explicitly; local
 * runs honor HOME and otherwise use the operating system's home directory.
 */
export function resolveNiriHome(
  env: NodeJS.ProcessEnv = process.env,
  osHome: string = os.homedir(),
): string {
  const configuredHome = env.NIRI_HOME?.trim() || env.HOME?.trim()
  return path.resolve(configuredHome || osHome)
}

/**
 * Harness home for soul, memories, and local databases.
 *
 * This is intentionally independent from where model-facing tools execute.
 * Set NIRI_HOME on each worker VM to give that agent her own persistent home.
 */
export const NIRI_HOME = resolveNiriHome()
