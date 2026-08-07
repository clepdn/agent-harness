export const CLIENT_TOOL_NAMES = ["shell", "read_file", "edit_file", "image_tool", "computer", "read_bytes"] as const

export type ClientToolName = (typeof CLIENT_TOOL_NAMES)[number]
export type ToolCapability = ClientToolName

export type WorkspaceDescriptor = {
  id: string
  root: string
  home?: string
  imageRoot?: string
  platform?: string
  persistentShell?: boolean
  hashline?: boolean
}

export type ToolInvocation = {
  type: "tool.call"
  invocationId: string
  agentId: string
  tool: ClientToolName
  args: Record<string, unknown>
  issuedAt: string
  deadlineAt: string
}

export type ClientImageArtifact = {
  path: string
  mime: string
  bytes: number
  dataUrl: string
}

/** Any file pulled off the client verbatim. Same shape, unconstrained mime. */
export type ClientFileArtifact = ClientImageArtifact

export type ClientToolResult = {
  type: "tool.result"
  invocationId: string
  agentId: string
  status: "ok" | "error" | "cancelled" | "unknown"
  output?: string
  image?: ClientImageArtifact
  file?: ClientFileArtifact
  completedAt: string
}

export function isClientToolName(value: unknown): value is ClientToolName {
  return typeof value === "string" && (CLIENT_TOOL_NAMES as readonly string[]).includes(value)
}

export function isToolCapability(value: unknown): value is ToolCapability {
  return isClientToolName(value)
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function validDate(value: unknown): value is string {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value))
}

export function parseToolInvocation(value: unknown): ToolInvocation | null {
  const input = record(value)
  const args = input && record(input.args)
  if (
    !input ||
    !args ||
    input.type !== "tool.call" ||
    !nonEmptyString(input.invocationId) ||
    !nonEmptyString(input.agentId) ||
    !isClientToolName(input.tool) ||
    !validDate(input.issuedAt) ||
    !validDate(input.deadlineAt)
  ) {
    return null
  }
  if (Date.parse(input.deadlineAt) < Date.parse(input.issuedAt)) return null
  return {
    type: "tool.call",
    invocationId: input.invocationId.trim(),
    agentId: input.agentId.trim(),
    tool: input.tool,
    args,
    issuedAt: input.issuedAt,
    deadlineAt: input.deadlineAt,
  }
}

function validArtifact(value: Record<string, unknown>, mimePattern: RegExp, status: unknown): boolean {
  return (
    nonEmptyString(value.path) &&
    nonEmptyString(value.mime) &&
    mimePattern.test(value.mime) &&
    typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    nonEmptyString(value.dataUrl) &&
    value.dataUrl.startsWith(`data:${value.mime};base64,`) &&
    status === "ok"
  )
}

function artifact(value: Record<string, unknown>): ClientImageArtifact {
  return {
    path: String(value.path),
    mime: String(value.mime),
    bytes: Number(value.bytes),
    dataUrl: String(value.dataUrl),
  }
}

export function parseClientToolResult(value: unknown): ClientToolResult | null {
  const input = record(value)
  if (
    !input ||
    input.type !== "tool.result" ||
    !nonEmptyString(input.invocationId) ||
    !nonEmptyString(input.agentId) ||
    !validDate(input.completedAt) ||
    !["ok", "error", "cancelled", "unknown"].includes(String(input.status)) ||
    (input.output !== undefined && typeof input.output !== "string")
  ) {
    return null
  }

  const image = input.image === undefined ? null : record(input.image)
  if (input.image !== undefined && !image) return null
  if (image && !validArtifact(image, /^image\/[a-z0-9.+-]+$/i, input.status)) return null

  const file = input.file === undefined ? null : record(input.file)
  if (input.file !== undefined && !file) return null
  if (file && !validArtifact(file, /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i, input.status)) return null

  return {
    type: "tool.result",
    invocationId: input.invocationId.trim(),
    agentId: input.agentId.trim(),
    status: input.status as ClientToolResult["status"],
    ...(typeof input.output === "string" ? { output: input.output } : {}),
    ...(image ? { image: artifact(image) } : {}),
    ...(file ? { file: artifact(file) } : {}),
    completedAt: input.completedAt,
  }
}
