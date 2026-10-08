export type RunnerPresence = "awake" | "resting"
export type RunnerPresenceListener = (presence: RunnerPresence) => void

export interface RunnerPresenceTracker {
  set(presence: RunnerPresence): void
  subscribe(listener: RunnerPresenceListener): () => void
}

export function createPresenceTracker(publish: (presence: RunnerPresence) => void): RunnerPresenceTracker {
  const listeners = new Set<RunnerPresenceListener>()
  let current: RunnerPresence = "resting"
  return {
    set(presence) {
      if (presence === current) return
      current = presence
      publish(presence)
      for (const listener of listeners) listener(presence)
    },
    subscribe(listener) {
      listener(current)
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
