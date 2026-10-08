import type { StreamEvent } from "@nano/protocol"
import type { RuntimeStreamService } from "@nano/runtime-api/contracts/events"
export type { StreamEvent, RuntimeStreamService }

export function createStreamService(
  publish: (event: StreamEvent) => void,
  options: { bufferSize?: number; consoleOutput?: boolean } = {},
): RuntimeStreamService {
  const bufferSize = options.bufferSize ?? 50
  if (!Number.isInteger(bufferSize) || bufferSize < 0) throw new RangeError("stream bufferSize must be a non-negative integer")
  const buffer: StreamEvent[] = []
  const listeners = new Set<(event: StreamEvent) => void>()
  const consoleOutput = options.consoleOutput !== false
  let activeConsoleText = false
  let closed = false
  const assertOpen = (): void => {
    if (closed) throw new Error("Stream service is closed")
  }

  const endConsoleText = (): void => {
    if (!activeConsoleText) return
    process.stdout.write("\n")
    activeConsoleText = false
  }

  const service: RuntimeStreamService = {
    emit(event) {
      assertOpen()
      if (consoleOutput) {
        if (event.type === "text" || event.type === "thinking") {
          const label = event.type === "text" ? "[nano] " : "[thinking] "
          if (!activeConsoleText) {
            process.stdout.write(label)
            activeConsoleText = true
          }
          process.stdout.write(event.text)
        } else {
          endConsoleText()
          if (event.type === "user") console.log(`[user/${event.source}] ${event.text}`)
        }
      }
      if (bufferSize > 0) {
        buffer.push(event)
        if (buffer.length > bufferSize) buffer.shift()
      }
      try {
        publish(event)
      } catch (error) {
        console.error("[stream] event publisher failed:", error)
      }
      for (const listener of listeners) {
        try { listener(event) } catch (error) {
          console.error("[stream] subscriber failed:", error)
        }
      }
    },
    subscribe(listener) {
      assertOpen()
      const snapshot = buffer.slice()
      let replaying = true
      const liveQueue: StreamEvent[] = []
      const wrapped = (event: StreamEvent): void => {
        if (replaying) liveQueue.push(event)
        else listener(event)
      }
      listeners.add(wrapped)
      try {
        for (const event of snapshot) listener(event)
      } catch (error) {
        listeners.delete(wrapped)
        console.error("[stream] replay subscriber failed:", error)
        return () => {}
      }
      replaying = false
      for (const event of liveQueue) {
        try { listener(event) } catch (error) {
          console.error("[stream] subscriber failed:", error)
        }
      }
      return () => listeners.delete(wrapped)
    },
    subscribeLive(listener) {
      assertOpen()
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      if (closed) return
      closed = true
      listeners.clear()
      buffer.length = 0
      endConsoleText()
    },
  }
  return service
}
