import type { Plugin, CordisContext } from "@nano/plugins"
import { configSchema } from "@nano/plugins"
import { getService, nano, type EventService, type PersistenceService } from "@nano/runtime-api"
import { createStreamService } from "./stream"
import { workerEvents, type StreamItem } from "@nano/protocol"

export interface EventPluginConfig {
  readonly bufferSize?: number
  readonly consoleOutput?: boolean
}

export function createEventService(
  persistence: Pick<PersistenceService, "publishWorkerEvent">,
  options: EventPluginConfig = {},
): EventService {
  return createStreamService((event) => persistence.publishWorkerEvent("stream.event", event), options)
}

export function formatEventStreamItem(item: StreamItem<typeof workerEvents>): string {
  if ("seq" in item) {
    const event = item.value
    return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  }
  return `event: gap\ndata: ${JSON.stringify(item)}\n\n`
}

function parseEventConfig(raw: unknown, defaults: EventPluginConfig): EventPluginConfig {
  if (raw == null) return defaults
  if (typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("nano.events config must be an object")
  const value = raw as EventPluginConfig
  if (value.bufferSize !== undefined && (!Number.isInteger(value.bufferSize) || value.bufferSize < 0)) {
    throw new TypeError("nano.events config.bufferSize must be a non-negative integer")
  }
  if (value.consoleOutput !== undefined && typeof value.consoleOutput !== "boolean") {
    throw new TypeError("nano.events config.consoleOutput must be a boolean")
  }
  return { ...defaults, ...value }
}

export function createEventPlugin(defaults: EventPluginConfig = {}): Plugin.Object<EventPluginConfig> {
  return {
    name: "nano.events",
    inject: ["nano.persistence"],
    provide: "nano.events",
    Config: configSchema((raw) => parseEventConfig(raw, defaults)),
    apply(ctx: CordisContext, config) {
      const persistence = getService(ctx, nano.persistence)
      const service = createEventService(persistence, config)
      return (function* () {
        yield () => service.close()
        yield ctx.provide(nano.events.name, service)
      })()
    },
  }
}
export const eventsPlugin = createEventPlugin()
export { createStreamService } from "./stream"
export type { RuntimeStreamService } from "@nano/runtime-api/contracts/events"
