import { spawn } from "node:child_process"
import { tryShim, SHIM_FAILED_ENV } from "./shim"
import { REPO_ROOT } from "./agent-config"
import { createServer } from "./server"
import { initDb } from "./db"
import { initMetricsDb } from "./metrics"
import { initSnapcompactRenderer } from "./runner/compaction-companion"
import { modelState } from "./runner/model-state"
import { REMOTE_COMPACTION_ENDPOINT } from "./runner/config"
import { shutdown, activate, startBoredomTimer } from "./runner/index"
import { initJobManager } from "./runner/jobs"
import { startDiscordGateway } from "./discord/gateway"
import { setGatewayCallbacks } from "./discord/slash-commands"
import { startDiscordEmbeddingBackfill } from "./discord/search"
import { setDiscordToolsAvailable } from "./discord/availability"
import { ensureSoulFilePlacement } from "./bootstrap"
import { clientTools } from "./client"
import { config } from "./config"

// The control plane assigns each worker its port via PORT; standalone runs take
// it from [server].port. Env wins so one config file can back many workers.
const PORT = Number.parseInt(process.env.PORT ?? String(config.server.port), 10)
const WORKER_HOST = process.env.NANO_WORKER_HOST?.trim() || config.server.listen
const RESTART_COMMAND = process.env.NANO_RESTART_COMMAND?.trim() || "npm run start:worker"
const MANAGED_WORKER = process.env.NANO_MANAGED_WORKER?.trim().toLowerCase() === "true"

function spawnReplacementProcess(): void {
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

async function main() {
  // Check for shim mode before anything else.
  // If the shim is active, this blocks until the child exits.
  // On clean exit (0) the process terminates here.
  // On failure we fall through to normal startup in safe mode.
  await tryShim()

  if (process.env[SHIM_FAILED_ENV]) {
    console.warn("[nano] started in safe mode — shim child failed, running from nix store")
  }

  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`invalid worker port: ${process.env.PORT ?? config.server.port}`)
  process.umask(0o077)
  console.log("[nano] starting up...")

  await clientTools.start()

  await ensureSoulFilePlacement()
  initDb()
  initMetricsDb()

  // If snapcompact bitmap frames are the configured deep-archive path, load the
  // native renderer eagerly now so a broken setup fails startup — loud, cheap —
  // instead of silently degrading to the text appendix later. Per-render
  // failures at runtime still degrade gracefully; only load failure is fatal.
  // This mirrors resolveDeepArchiveBackend's branch that builds a frames backend:
  // deep_archive on, not the openai-remote path, primary model vision-capable.
  {
    const activeModel = modelState.useFallback ? modelState.fallbackModel : modelState.primaryModel
    const provider = (activeModel?.provider ?? "").toLowerCase()
    const framesIntended =
      modelState.deepArchive &&
      !(provider.includes("openai") && REMOTE_COMPACTION_ENDPOINT) &&
      modelState.primaryVision
    if (framesIntended) {
      await initSnapcompactRenderer()
    }
  }

  // Wire background jobs (e.g. subagents) to wake/steer the runner on completion.
  // Without this, deliver stays null and completed-job notifications are silently dropped.
  initJobManager(activate)

  const discordEmbeddingBackfill = startDiscordEmbeddingBackfill()

  let discordGateway: Awaited<ReturnType<typeof startDiscordGateway>> = null
  try {
    discordGateway = await startDiscordGateway()
  } catch (err) {
    console.warn("[discord gateway] startup failed:", err)
  }
  setDiscordToolsAvailable(Boolean(discordGateway))

  let shuttingDown = false
  let restartRequested = false
  let restartReason: string | undefined

  function requestRestart(reason?: string): void {
    if (restartRequested || shuttingDown) return
    restartRequested = true
    restartReason = reason?.trim() || undefined
    setTimeout(() => {
      void gracefulShutdown("RESTART")
    }, 50).unref?.()
  }

  function requestShutdown(): void {
    if (restartRequested || shuttingDown) return
    setTimeout(() => {
      void gracefulShutdown("SHUTDOWN")
    }, 50).unref?.()
  }

  const server = createServer({ requestRestart, requestShutdown })
  setGatewayCallbacks({ requestRestart, requestShutdown })

  await server.listen({ port: PORT, host: WORKER_HOST })
  console.log(`[nano] listening on ${WORKER_HOST}:${PORT}`)
  startBoredomTimer()

  async function gracefulShutdown(sig: string) {
    if (shuttingDown) return  // ignore duplicate signals
    shuttingDown = true
    const detail = restartRequested && restartReason ? ` (${restartReason})` : ""
    console.log(`\n[nano] ${sig} received${detail}, saving session snapshot...`)

    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => { console.log("[nano] shutdown timed out, forcing exit"); resolve() }, 300_000)
    )

    await Promise.race([shutdown(), timeout])

    const cleanup = async () => {
      discordEmbeddingBackfill.stop()
      if (discordGateway) await discordGateway.stop()
      setDiscordToolsAvailable(false)
      await server.close()
      await clientTools.stop()
    }
    const cleanupTimeout = new Promise<void>((resolve) =>
      setTimeout(() => { console.log("[nano] cleanup timed out, exiting anyway"); resolve() }, 10_000)
    )
    await Promise.race([cleanup(), cleanupTimeout])
    if (restartRequested && !MANAGED_WORKER) spawnReplacementProcess()
    process.exit(0)
  }

  process.on("SIGINT", async () => {
    if (shuttingDown) {
      console.log("\n[nano] force exit")
      process.exit(1)
    }
    await gracefulShutdown("SIGINT")
  })

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
}

main().catch((err) => {
  console.error("[nano] fatal:", err)
  process.exit(1)
})
