/** Counts a quiet interval across event waits, without firing during work. */
export function createBoredomTimer(delayMs: number, activate: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let deadline: number | undefined
  let stopped = false

  function pause(): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  return {
    idle(): void {
      if (stopped || !Number.isFinite(delayMs) || delayMs <= 0 || timer !== undefined) return
      deadline ??= Date.now() + delayMs
      timer = setTimeout(() => {
        timer = undefined
        deadline = undefined
        activate()
      }, Math.max(1, deadline - Date.now()))
      timer.unref?.()
    },
    // Preserve the deadline across idle compaction timeouts.
    pause,
    active(): void {
      pause()
      deadline = undefined
    },
    stop(): void {
      stopped = true
      pause()
      deadline = undefined
    },
  }
}
