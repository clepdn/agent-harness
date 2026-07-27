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

/** Repository fallback home used when a local OS home is unavailable. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
export const REPO_HOME_DIR = path.resolve(process.env.NIRI_REPO_HOME ?? path.join(REPO_ROOT, "home"))

/**
 * Harness home for soul, memories, and local databases.
 *
 * This is intentionally independent from where model-facing tools execute.
 * Set NIRI_HOME on each worker VM to give that agent her own persistent home.
 */
export const NIRI_HOME = path.resolve(process.env.NIRI_HOME ?? process.env.HOME ?? REPO_HOME_DIR)
