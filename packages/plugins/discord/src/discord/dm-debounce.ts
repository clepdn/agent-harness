// Discord wake debounce.
//
// When a DM arrives we hold the wake briefly so typing signals and rapid
// follow-up messages can be batched. Each typing signal or follow-up extends
// the hold by `baseMs`, up to `capMs` from the first message in the burst.
// Configured channel messages use the same timer but typing only extends DMs.

type Pending = {
  key: string
  queuedItems: unknown[]
  fire: (queuedItems: readonly unknown[]) => void
  firstAt: number
  timer: ReturnType<typeof setTimeout>
}

export type DiscordDebounceDelay = number | (() => number)

export type DiscordDebounceOptions = {
  baseMs: DiscordDebounceDelay
  capMs: DiscordDebounceDelay
}

export type DiscordDebounce = {
  debounceDmWake<T>(
    channelId: string,
    userId: string,
    item: T,
    fire: (queuedItems: readonly T[]) => void,
  ): boolean
  debounceChannelWake<T>(
    channelId: string,
    item: T,
    fire: (queuedItems: readonly T[]) => void,
  ): boolean
  noteDmTyping(channelId: string, userId?: string): void
  reset(): void
}

function readDelay(value: DiscordDebounceDelay): number {
  return Math.max(0, typeof value === "function" ? value() : value)
}

function pendingKey(scope: "dm" | "channel", channelId: string, userId = ""): string {
  return `${scope}\u0000${channelId}\u0000${userId}`
}

export function createDiscordDebounce({ baseMs, capMs }: DiscordDebounceOptions): DiscordDebounce {
  const pending = new Map<string, Pending>()

  const getBaseMs = () => readDelay(baseMs)
  const getCapMs = () => Math.max(getBaseMs(), readDelay(capMs))

  function clearPending(key: string): void {
    const entry = pending.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(key)
  }

  function scheduleTimer(entry: Pending): void {
    clearTimeout(entry.timer)
    const now = Date.now()
    const capDeadline = entry.firstAt + getCapMs()
    const nextFireAt = Math.min(now + getBaseMs(), capDeadline)
    const delay = Math.max(0, nextFireAt - now)
    entry.timer = setTimeout(() => {
      pending.delete(entry.key)
      try {
        entry.fire(entry.queuedItems)
      } catch (err) {
        console.warn("[discord-debounce] wake fire failed:", err)
      }
    }, delay)
    if (typeof entry.timer.unref === "function") entry.timer.unref()
  }

  function debounceWake<T>(
    key: string,
    item: T,
    fire: (queuedItems: readonly T[]) => void,
  ): boolean {
    if (getBaseMs() <= 0) return false

    const existing = pending.get(key)
    if (existing) {
      existing.queuedItems.push(item)
      existing.fire = fire as (queuedItems: readonly unknown[]) => void
      scheduleTimer(existing)
      return true
    }

    const entry: Pending = {
      key,
      queuedItems: [item],
      fire: fire as (queuedItems: readonly unknown[]) => void,
      firstAt: Date.now(),
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    }
    pending.set(key, entry)
    scheduleTimer(entry)
    return true
  }

  return {
    debounceDmWake<T>(
      channelId: string,
      userId: string,
      item: T,
      fire: (queuedItems: readonly T[]) => void,
    ): boolean {
      const normalizedUserId = userId.trim()
      return debounceWake(pendingKey("dm", channelId, normalizedUserId), item, fire)
    },

    // Channel wake batches are keyed by channel rather than author.
    debounceChannelWake<T>(
      channelId: string,
      item: T,
      fire: (queuedItems: readonly T[]) => void,
    ): boolean {
      return debounceWake(pendingKey("channel", channelId), item, fire)
    },

    noteDmTyping(channelId: string, userId?: string): void {
      const normalizedUserId = userId?.trim()
      if (!normalizedUserId) return
      const entry = pending.get(pendingKey("dm", channelId, normalizedUserId))
      if (entry) scheduleTimer(entry)
    },

    reset(): void {
      for (const key of [...pending.keys()]) clearPending(key)
    },
  }
}
