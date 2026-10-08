import type { ClientImageArtifact } from "@nano/harness-protocol"

export type ContextImageReference =
  | { kind: "markdown"; path: string; label: string }
  | { kind: "discord-avatar"; userId: string; label: string; avatar?: string | null; discriminator?: string; own?: boolean }
  | { kind: "discord-emoji"; emojiId: string; name: string; animated: boolean; label: string }

export interface ContextImageAttachment {
  type: "image"
  data: string
  mimeType: string
  key: string
  label: string
}

export interface ContextImageState {
  imageReferences?: ContextImageReference[]
  imageAttachments?: ContextImageAttachment[]
  imageNotes?: string[]
  imagesSuppressed?: boolean
}

export type DiscordContextImageLoader = {
  loadAvatar: (ref: Extract<ContextImageReference, { kind: "discord-avatar" }>) => Promise<ContextImageAttachment>
  loadEmoji: (ref: Extract<ContextImageReference, { kind: "discord-emoji" }>) => Promise<ContextImageAttachment>
}


export type RemoteImageDependencies = {
  fetch?: typeof globalThis.fetch
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>
  maxBytes?: number
}

export type FetchRemoteImage = (
  input: string,
  signal?: AbortSignal,
  dependencies?: RemoteImageDependencies,
) => Promise<ClientImageArtifact>
