import path from "node:path"
import { config } from "@nano/runtime-api/config"
import { NANO_HOME } from "@nano/runtime-api/agent-config"

const configuredContainerName = config.container.name
const configuredContainerUser = config.container.user
const useDockerShell = configuredContainerName.length > 0 && configuredContainerUser.length > 0

/** Absolute image root allowed for image_tool operations. */
export const IMAGE_ROOT = (() => {
  const configured = config.image_tool.root
  const root = configured || (useDockerShell ? `/home/${configuredContainerUser || "nano"}/images` : path.join(NANO_HOME, "images"))
  if (!root.startsWith("/")) throw new Error(`[image_tool].root must be an absolute path, got: ${root}`)
  return path.posix.normalize(root)
})()

const DEFAULT_IMAGE_MAX_BYTES = 150_000
/** Maximum image size (bytes) accepted by image_tool and remote image fetches. */
export const IMAGE_MAX_BYTES = (() => {
  const parsed = config.image_tool.max_bytes
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_IMAGE_MAX_BYTES
  return parsed
})()

export function imageRootForModelInput(): string {
  return IMAGE_ROOT
}
