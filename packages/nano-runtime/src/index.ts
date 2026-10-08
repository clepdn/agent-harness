import { spawn } from "node:child_process"
import { REPO_ROOT } from "@nano/runtime-api/agent-config"
import { config } from "@nano/runtime-api/config"
import { tryShim, SHIM_FAILED_ENV } from "@nano/runtime-api/shim"
import { createNanoApplication } from "./plugins/application"
import type { NanoApplication } from "./plugins/application"

const PORT = Number.parseInt(process.env.PORT ?? String(config.server.port), 10)
const HOST = process.env.NANO_WORKER_HOST?.trim() || config.server.listen
const RESTART_COMMAND = process.env.NANO_RESTART_COMMAND?.trim() || "npm run start:worker"
const MANAGED_WORKER = process.env.NANO_MANAGED_WORKER?.trim().toLowerCase() === "true"

function spawnReplacement(): void {
  console.log(`[nano] spawning replacement: ${RESTART_COMMAND}`)
  const child = spawn(RESTART_COMMAND, {
    cwd: process.env.NANO_RESTART_CWD?.trim() || REPO_ROOT,
    env: process.env,
    shell: true,
    detached: true,
    stdio: "inherit",
  })
  child.unref()
}

async function main(): Promise<void> {
  await tryShim()
  if (process.env[SHIM_FAILED_ENV]) console.warn("[nano] started in safe mode — shim child failed, running from nix store")
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("Invalid worker port")
  process.umask(0o077)
  console.log("[nano] starting up...")
  let application: NanoApplication | undefined
  let closing: Promise<void> | undefined
  let restart = false
  let restartReason: string | undefined

  async function close(reason: string): Promise<void> {
    if (closing) return closing
    closing = (async () => {
      console.log(`[nano] ${reason}${restartReason ? ` (${restartReason})` : ""}, saving sessions and closing plugins...`)
      await application?.close()
      if (restart && !MANAGED_WORKER) spawnReplacement()
      process.exitCode = 0
    })()
    return closing
  }

  const requestClose = (reason: string) => {
    setTimeout(() => { void close(reason).catch((error) => { console.error("[nano] shutdown failed:", error); process.exitCode = 1 }) }, 50).unref()
  }
  application = await createNanoApplication({
    config,
    listen: { port: PORT, host: HOST },
    ...(config.prometheus.port > 0 ? { observability: { port: config.prometheus.port } } : {}),
    lifecycle: {
      shutdown() { if (!closing) requestClose("SHUTDOWN") },
      restart(reason) {
        if (closing || restart) return
        restart = true
        restartReason = reason?.trim() || undefined
        requestClose("RESTART")
      },
    },
  })
  process.on("SIGINT", () => {
    if (closing) process.exit(1)
    void close("SIGINT")
  })
  process.on("SIGTERM", () => { void close("SIGTERM") })
}

void main().catch((error) => {
  console.error("[nano] fatal:", error)
  process.exitCode = 1
})
