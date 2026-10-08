import type { Plugin } from "@nano/plugins"
import { nano, type EventService, type PersistenceService } from "./api"
import { createStreamService } from "../stream"

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

export function createEventPlugin(defaults: EventPluginConfig = {}): Plugin<EventPluginConfig> {
  return {
    id: "nano.events",
    requires: [nano.persistence],
    provides: [nano.events],
    validate(raw) {
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
    },
    apply(scope, config) {
      const persistence = scope.use(nano.persistence)
      const service = createEventService(persistence, config)
      const remove = scope.provide(nano.events, service)
      return () => {
        service.close()
        return remove()
      }
    },
  }
}
export const eventsPlugin = createEventPlugin()
