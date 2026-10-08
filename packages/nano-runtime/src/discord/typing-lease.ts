/** Outbound Discord typing lease for one model turn. */

export type DiscordTypingSender = (channelId: string) => Promise<void> | void
export type DiscordTypingTimer = NodeJS.Timeout

export type DiscordTypingLease = {
  turnId: string
  channelId: string
  refreshTimer: DiscordTypingTimer | null
  longToolTimer: DiscordTypingTimer | null
  started: boolean
  paused: boolean
}

export interface DiscordTypingController {
  configure(sender: DiscordTypingSender | null, enabled?: boolean): void
  dispatch(turnId: string, channelId: string): void
  notify(turnId: string): void
  stop(turnId?: string): void
  beginToolWait(turnId: string): void
  endToolWait(turnId: string): void
  cleanup(scope: DiscordTypingScope): void
  reset(): void
}

export type DiscordTypingScope = {
  discordTypingTurnId?: string
  discordTypingChannelId?: string
}

const REFRESH_MS = 8_000
const LONG_TOOL_WAIT_MS = 20_000

/** Creates a typing-lease manager scoped to one Discord client. */
export function createDiscordTypingLease(
  initialSender: DiscordTypingSender | null = null,
  initialEnabled = true,
): DiscordTypingController {
  let sender: DiscordTypingSender | null = initialEnabled ? initialSender : null
  let activeLease: DiscordTypingLease | null = null

  function clearLeaseTimers(lease: DiscordTypingLease): void {
    if (lease.refreshTimer) clearInterval(lease.refreshTimer)
    if (lease.longToolTimer) clearTimeout(lease.longToolTimer)
    lease.refreshTimer = null
    lease.longToolTimer = null
  }

  function stop(turnId?: string): void {
    const lease = activeLease
    if (!lease || (turnId !== undefined && lease.turnId !== turnId)) return
    clearLeaseTimers(lease)
    activeLease = null
  }

  async function sendTyping(lease: DiscordTypingLease): Promise<void> {
    if (activeLease !== lease || lease.paused || !sender) return
    try {
      await sender(lease.channelId)
    } catch (err) {
      console.warn(`[discord typing] failed for channel ${lease.channelId}:`, err)
      stop(lease.turnId)
    }
  }

  function startLease(lease: DiscordTypingLease): void {
    if (activeLease !== lease || lease.paused || !sender) return
    if (!lease.started) {
      lease.started = true
      void sendTyping(lease)
    }
    if (lease.refreshTimer) return
    lease.refreshTimer = setInterval(() => void sendTyping(lease), REFRESH_MS)
    lease.refreshTimer.unref?.()
  }

  function configure(next: DiscordTypingSender | null, enabled = true): void {
    stop()
    sender = enabled ? next : null
  }

  function dispatch(turnId: string, channelId: string): void {
    const normalizedTurnId = turnId.trim()
    const normalizedChannelId = channelId.trim()
    if (!normalizedTurnId || !normalizedChannelId || !sender) return

    stop()
    activeLease = {
      turnId: normalizedTurnId,
      channelId: normalizedChannelId,
      refreshTimer: null,
      longToolTimer: null,
      started: false,
      paused: false,
    }
  }

  function notify(turnId: string): void {
    const lease = activeLease
    if (lease?.turnId === turnId) startLease(lease)
  }

  function cleanup(scope: DiscordTypingScope): void {
    stop(scope.discordTypingTurnId)
    scope.discordTypingTurnId = undefined
    scope.discordTypingChannelId = undefined
  }

  function beginToolWait(turnId: string): void {
    const lease = activeLease
    if (!lease || lease.turnId !== turnId || lease.longToolTimer) return
    lease.longToolTimer = setTimeout(() => {
      lease.longToolTimer = null
      if (activeLease !== lease || !lease.started) return
      lease.paused = true
      if (lease.refreshTimer) clearInterval(lease.refreshTimer)
      lease.refreshTimer = null
    }, LONG_TOOL_WAIT_MS)
    lease.longToolTimer.unref?.()
  }

  function endToolWait(turnId: string): void {
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

  function reset(): void {
    stop()
    sender = null
  }

  return { configure, dispatch, notify, stop, beginToolWait, endToolWait, cleanup, reset }
}

/** Clears per-turn typing metadata without consulting shared state. */
export function clearDiscordTypingScope(scope: DiscordTypingScope): void {
  scope.discordTypingTurnId = undefined
  scope.discordTypingChannelId = undefined
}
