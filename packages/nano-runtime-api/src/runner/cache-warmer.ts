import type { Context, Usage } from "../llm"
import { cacheRefreshIntervalMs } from "../cache-policy"
export { cacheRefreshIntervalMs } from "../cache-policy"

type CacheWarmContext = Pick<Context, "lastCacheUseAt" | "warmCache"> & { readonly lastCompletionAt?: number }

/** Round the quiet-time budget up to the next actual refresh boundary. */
export function cacheWarmingCompactionAt(lastCompletionAt: number | undefined, lifetimeMs: number, durationMs: number): number | undefined {
  const interval = cacheRefreshIntervalMs(lifetimeMs)
  if (lastCompletionAt === undefined || !Number.isFinite(lastCompletionAt) || interval <= 0 ||
      !Number.isFinite(durationMs) || durationMs <= 0) return undefined
  const deadline = lastCompletionAt + Math.ceil(durationMs / interval) * interval
  return Number.isFinite(deadline) ? deadline : undefined
}

interface CacheWarmTarget<T extends CacheWarmContext> {
  context: T
  lifetimeMs: number
  durationMs?: number
  mode: "completion" | "prewarm"
  enabled: boolean
  busy: boolean
}

/** Keep the last successful prompt warm without waking or changing the agent. */
export function createCacheWarmer<T extends CacheWarmContext>(options: {
  target: () => CacheWarmTarget<T>
  onUsage: (target: CacheWarmTarget<T>, usage: Usage) => void
  onError: (error: unknown) => void
}) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let stopped = false

  function schedule(): void {
    if (stopped) return
    const target = options.target()
    const lastUsed = target.context.lastCacheUseAt
    // Refresh three minutes early, leaving room for network/provider latency.
    const due = lastUsed !== undefined ? lastUsed + cacheRefreshIntervalMs(target.lifetimeMs) - Date.now() : Infinity
    const eligible = target.enabled && cacheRefreshIntervalMs(target.lifetimeMs) > 0 && !target.busy
    timer = setTimeout(() => { void tick() }, eligible && due > 0 ? Math.min(60_000, Math.max(1, due)) : 60_000)
    timer.unref?.()
  }

  async function tick(): Promise<void> {
    timer = undefined
    const target = options.target()
    const lastUsed = target.context.lastCacheUseAt
    const compactionAt = cacheWarmingCompactionAt(target.context.lastCompletionAt, target.lifetimeMs, target.durationMs ?? 0)
    if (!target.enabled || target.busy || cacheRefreshIntervalMs(target.lifetimeMs) <= 0 ||
        lastUsed === undefined || Date.now() - lastUsed < cacheRefreshIntervalMs(target.lifetimeMs) ||
        (compactionAt !== undefined && Date.now() >= compactionAt)) {
      schedule()
      return
    }
    const requestController = new AbortController()
    controller = requestController
    try {
      const usage = await target.context.warmCache({ signal: requestController.signal, timeoutMs: 60_000, mode: target.mode })
      if (usage) options.onUsage(target, usage)
    } catch (error) {
      if (!requestController.signal.aborted) options.onError(error)
    } finally {
      if (controller === requestController) controller = undefined
      // A failed attempt waits one minute instead of retrying in a tight loop.
      schedule()
    }
  }

  schedule()
  return {
    activity(): void { controller?.abort() },
    stop(): void {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      controller?.abort()
    },
  }
}
