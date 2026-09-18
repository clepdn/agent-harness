/** Outbound Discord typing lease for one model turn. */

export type DiscordTypingSender = (channelId: string) => Promise<void> | void
export type DiscordTypingTimer = ReturnType<typeof setTimeout>

export type DiscordTypingLease = {
  turnId: string
  channelId: string
  refreshTimer: DiscordTypingTimer | null
  longToolTimer: DiscordTypingTimer | null
  started: boolean
  paused: boolean
}

const REFRESH_MS = 8_000
const LONG_TOOL_WAIT_MS = 20_000

let sender: DiscordTypingSender | null = null
let activeLease: DiscordTypingLease | null = null

function clearLeaseTimers(lease: DiscordTypingLease): void {
  clearInterval(lease.refreshTimer as unknown as ReturnType<typeof setInterval>)
  clearTimeout(lease.longToolTimer as ReturnType<typeof setTimeout>)
  lease.refreshTimer = null
  lease.longToolTimer = null
}

async function sendTyping(lease: DiscordTypingLease): Promise<void> {
  if (activeLease !== lease || lease.paused || !sender) return
  try {
    await sender(lease.channelId)
  } catch (err) {
    console.warn(`[discord typing] failed for channel ${lease.channelId}:`, err)
    stopDiscordTyping(lease.turnId)
  }
}

function startLease(lease: DiscordTypingLease): void {
  if (activeLease !== lease || lease.paused || !sender) return
  if (!lease.started) {
    lease.started = true
    void sendTyping(lease)
  }
  if (lease.refreshTimer) return
  lease.refreshTimer = setInterval(() => void sendTyping(lease), REFRESH_MS) as unknown as DiscordTypingTimer
  lease.refreshTimer.unref?.()
}

/** Installs the gateway-backed typing transport. */
export function configureDiscordTyping(next: DiscordTypingSender | null, enabled = true): void {
  stopDiscordTyping()
  sender = enabled ? next : null
}

/** Opens a lease for a newly dispatched Discord response. */
export function dispatchDiscordTyping(turnId: string, channelId: string): void {
  const normalizedTurnId = turnId.trim()
  const normalizedChannelId = channelId.trim()
  if (!normalizedTurnId || !normalizedChannelId || !sender) return

  stopDiscordTyping()
  const lease: DiscordTypingLease = {
    turnId: normalizedTurnId,
    channelId: normalizedChannelId,
    refreshTimer: null,
    longToolTimer: null,
    started: false,
    paused: false,
  }
  activeLease = lease
}

/** Marks first model activity, starting the matching lease synchronously. */
export function notifyDiscordModelActivity(turnId: string): void {
  const lease = activeLease
  if (lease?.turnId === turnId) startLease(lease)
}

/** Finishes/cancels/errors/supersedes one turn and synchronously clears timers. */
export function stopDiscordTyping(turnId?: string): void {
  const lease = activeLease
  if (!lease || (turnId !== undefined && lease.turnId !== turnId)) return
  clearLeaseTimers(lease)
  activeLease = null
}
/** Clears the state and manager for a response scope before a new event is injected. */
export function clearDiscordTypingScope(scope: {
  discordTypingTurnId?: string
  discordTypingChannelId?: string
}): void {
  stopDiscordTyping(scope.discordTypingTurnId)
  scope.discordTypingTurnId = undefined
  scope.discordTypingChannelId = undefined
}

/** Starts a long-tool threshold timer for the matching turn. */
export function beginDiscordToolWait(turnId: string): void {
  const lease = activeLease
  if (!lease || lease.turnId !== turnId || lease.longToolTimer) return
  lease.longToolTimer = setTimeout(() => {
    lease.longToolTimer = null
    if (activeLease !== lease || !lease.started) return
    lease.paused = true
    clearInterval(lease.refreshTimer as ReturnType<typeof setInterval>)
    lease.refreshTimer = null
  }, LONG_TOOL_WAIT_MS)
  lease.longToolTimer.unref?.()
}

/** Resumes a paused lease after tool completion. */
export function endDiscordToolWait(turnId: string): void {
  const lease = activeLease
  if (!lease || lease.turnId !== turnId) return
  clearTimeout(lease.longToolTimer as ReturnType<typeof setTimeout>)
  lease.longToolTimer = null
  if (lease.paused) {
    lease.paused = false
    void sendTyping(lease)
    startLease(lease)
  }
}

export const __discordTypingLeaseTest = {
  refreshMs: REFRESH_MS,
  longToolWaitMs: LONG_TOOL_WAIT_MS,
  reset(): void {
    stopDiscordTyping()
    sender = null
  },
}
