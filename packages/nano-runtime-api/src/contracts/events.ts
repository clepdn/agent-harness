import type { StreamEvent } from "@nano/protocol"

export interface RuntimeStreamService {
  emit(event: StreamEvent): void
  subscribe(listener: (event: StreamEvent) => void): () => void
  subscribeLive(listener: (event: StreamEvent) => void): () => void
  close(): void
}

export interface EventService extends RuntimeStreamService {}

export interface EventPluginConfig {
  readonly bufferSize?: number
  readonly consoleOutput?: boolean
}
