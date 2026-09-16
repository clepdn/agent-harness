import { config } from "../config"

// Discord wake debounce.
//
// When a DM arrives we don't wake the runner immediately. Instead we hold the
// wake for a short base delay so that:
//   1. the TYPING_START event (which usually lands a beat *after* the message)
//      can arrive and tell us the user is still composing a DM, and
//   2. rapid-fire follow-up messages get batched into a single wake instead of
//      spawning one activation per line.
//
// Each typing signal or follow-up message extends the hold by `baseMs`, up to a
// hard `capMs` ceiling measured from the first message in the burst. When the
// timer finally elapses we fire the wake once. Configured channel messages use
// the same timer but do not extend it from typing events.

type Pending = {
  key: string
  channelId: string
  userId: string
  queuedItems: unknown[]
  fire: (queuedItems: readonly unknown[]) => void
  firstAt: number
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()

function pendingKey(scope: "dm" | "channel", channelId: string, userId = ""): string {
  return `${scope}\u0000${channelId}\u0000${userId}`
}

function baseMs(): number {
  return Math.max(0, config.discord.dm_wake_debounce_ms)
}

function capMs(): number {
  return Math.max(baseMs(), config.discord.dm_wake_debounce_cap_ms)
}

function clearPending(key: string): void {
  const entry = pending.get(key)
  if (!entry) return
  clearTimeout(entry.timer)
  pending.delete(key)
}

function scheduleTimer(entry: Pending): void {
  clearTimeout(entry.timer)
  const now = Date.now()
  const capDeadline = entry.firstAt + capMs()
  // Extend by baseMs, but never past the cap deadline.
  const nextFireAt = Math.min(now + baseMs(), capDeadline)
  const delay = Math.max(0, nextFireAt - now)
  entry.timer = setTimeout(() => {
    pending.delete(entry.key)
    try {
      entry.fire(entry.queuedItems)
    } catch (err) {
      console.warn("[discord-debounce] wake fire failed:", err)
    }
  }, delay)
  // Let the process exit cleanly if this is the only thing pending.
  if (typeof entry.timer.unref === "function") entry.timer.unref()
}

// Called at Discord ingress when a DM becomes wake-eligible. The trailing
// wake is keyed by both channel and initiating author, so independent users
// in a group DM cannot extend or suppress one another's burst.
//
// Every message in the burst is retained and delivered together when the hold
// expires. Returns true if the wake was deferred (caller should NOT wake now).
function debounceWake<T>(
  key: string,
  channelId: string,
  userId: string,
  item: T,
  fire: (queuedItems: readonly T[]) => void,
): boolean {
  if (baseMs() <= 0) return false // debounce disabled

  const existing = pending.get(key)
  if (existing) {
    existing.queuedItems.push(item)
    existing.fire = fire as (queuedItems: readonly unknown[]) => void
    scheduleTimer(existing)
    return true
  }

  const entry: Pending = {
    key,
    channelId,
    userId: userId.trim(),
    queuedItems: [item],
    fire: fire as (queuedItems: readonly unknown[]) => void,
    firstAt: Date.now(),
    timer: undefined as unknown as ReturnType<typeof setTimeout>,
  }
  pending.set(key, entry)
  scheduleTimer(entry)
  return true
}

export function debounceDmWake<T>(
  channelId: string,
  userId: string,
  item: T,
  fire: (queuedItems: readonly T[]) => void,
): boolean {
  const normalizedUserId = userId.trim()
  return debounceWake(pendingKey("dm", channelId, normalizedUserId), channelId, normalizedUserId, item, fire)
}

// Configured channel traffic uses the same trailing debounce window as DMs.
// The key is the channel rather than the author so a rapid conversation wakes
// the agent once with every message in arrival order.
export function debounceChannelWake<T>(
  channelId: string,
  item: T,
  fire: (queuedItems: readonly T[]) => void,
): boolean {
  return debounceWake(pendingKey("channel", channelId), channelId, "", item, fire)
}

// Called on a TYPING_START for a DM channel. Only the matching initiating
// user/channel entry extends the hold; a typing event without a user id cannot
// be associated safely and never creates or changes a pending wake.
export function noteDmTyping(channelId: string, userId?: string): void {
  const normalizedUserId = userId?.trim()
  if (!normalizedUserId) return
  const entry = pending.get(pendingKey("dm", channelId, normalizedUserId))
  if (entry) scheduleTimer(entry)
}

// Test/shutdown helper.
export function _resetDmDebounce(): void {
  for (const key of [...pending.keys()]) clearPending(key)
}
