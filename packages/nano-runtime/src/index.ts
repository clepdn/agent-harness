import { initializeBridgeModelMetadata, type BridgeModelMetadataTarget } from "./bridge-model-metadata"
import { spawn } from "node:child_process"
import { tryShim, SHIM_FAILED_ENV } from "./shim"
import { REPO_ROOT } from "./agent-config"
import { createServer } from "./server"
import { initDb } from "./db"
import { initMetricsDb } from "./metrics"
import { initSnapcompactRenderer } from "./runner/compaction-companion"
import { modelState, modelStateFor } from "./runner/model-state"
import { REMOTE_COMPACTION_ENDPOINT } from "./runner/config"
import { primaryModel, fallbackModel, summaryModel } from "./runner/config"
import { shutdown, activate, startBoredomTimer } from "./runner/index"
import { activateFrontend, shutdownFrontend, startFrontendBoredomTimer } from "./runner/frontend"
import { configureAgentChannelDelivery } from "./runner/agent-channel"
import { initJobManager } from "./runner/jobs"
import { startDiscordGateway } from "./discord/gateway"
import { setGatewayCallbacks } from "./discord/slash-commands"
import { startDiscordEmbeddingBackfill } from "./discord/search"
import { setDiscordToolsAvailable } from "./discord/availability"
import { ensureSoulFilePlacement } from "./bootstrap"
import { reconcileFrontendSoul } from "./frontend-soul"
import { clearSession } from "./runner/session"
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
  const frontendRuntime = config.frontend.enable ? modelStateFor("frontend") : null
  const metadataTargets: BridgeModelMetadataTarget[] = [
    ...(primaryModel ? [{ model: primaryModel, apiKey: config.model.api_key }] : []),
    { model: fallbackModel, apiKey: config.fallback.api_key },
    ...(summaryModel ? [{ model: summaryModel, apiKey: config.summary.api_key }] : []),
    ...(frontendRuntime?.primaryModel ? [{ model: frontendRuntime.primaryModel, apiKey: frontendRuntime.primaryApiKey }] : []),
  ]
  await initializeBridgeModelMetadata(metadataTargets)

  await ensureSoulFilePlacement()
  let frontendSoulConflict = false
  if (config.frontend.enable) {
    const frontendSoul = await reconcileFrontendSoul()
    frontendSoulConflict = frontendSoul.conflicted
    if (frontendSoul.requiresFreshSession) {
      await clearSession("frontend")
      console.warn(`[frontend soul] ${frontendSoul.conflicted ? "merge conflict requires frontend reconciliation" : "rebased onto the current main soul"}; cleared the stale frontend session`)
    }
  }
  initDb()
  initMetricsDb()

  // If snapcompact bitmap frames are the configured deep-archive path, load the
  // native renderer eagerly now so a broken setup fails startup — loud, cheap —
  // instead of silently degrading to the text appendix later. Per-render
  // failures at runtime still degrade gracefully; only load failure is fatal.
  // This mirrors resolveDeepArchiveBackend's branch that builds a frames backend:
  // deep_archive on, not the openai-remote path, primary model vision-capable.
  {
    const runtimeModels = config.frontend.enable
      ? [modelState, modelStateFor("frontend")]
      : [modelState]
    const framesIntended = runtimeModels.some((models) => {
      const activeModel = models.useFallback ? models.fallbackModel : models.primaryModel
      const provider = (activeModel?.provider ?? "").toLowerCase()
      return models.deepArchive &&
        !(provider.includes("openai") && REMOTE_COMPACTION_ENDPOINT) &&
        models.primaryVision
    })
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

  if (frontendSoulConflict) {
    activateFrontend({
      source: "system",
      triggeredAt: new Date().toISOString(),
      raw: null,
      content: "[frontend soul merge conflict] Your virtual memory://soul.md contains unresolved merge markers after the main soul changed. Read memory://soul.md, reconcile the main and frontend versions, then edit the virtual soul to remove all markers. Your edits update the frontend patch; the main soul is unchanged.",
    })
  }

  // Replay durable virtual-agent mail only after client, jobs, compaction, and
  // Discord availability are initialized. A replay may wake either loop and
  // its first pinned catalog must reflect the fully started worker.
  if (config.frontend.enable) {
    configureAgentChannelDelivery((recipient, event) => {
      if (recipient === "frontend") return activateFrontend(event)
      activate(event)
      return true
    })
  }

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
  startFrontendBoredomTimer()

  async function gracefulShutdown(sig: string) {
    if (shuttingDown) return  // ignore duplicate signals
    shuttingDown = true
    const detail = restartRequested && restartReason ? ` (${restartReason})` : ""
    console.log(`\n[nano] ${sig} received${detail}, saving session snapshot...`)

    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => { console.log("[nano] shutdown timed out, forcing exit"); resolve() }, 300_000)
    )

    await Promise.race([Promise.all([shutdown(), shutdownFrontend()]).then(() => {}), timeout])

    const cleanup = async () => {
      discordEmbeddingBackfill.stop()
      configureAgentChannelDelivery(null)
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
