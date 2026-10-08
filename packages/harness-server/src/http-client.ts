import { randomUUID } from "node:crypto"
import type { ClientToolExecutor } from "@nano/harness-core"
import {
  CLIENT_TOOL_NAMES,
  parseClientToolResult,
  type ClientToolName,
  type ClientToolResult,
  type ToolCapability,
  type ToolInvocation,
  type WorkspaceDescriptor,
} from "@nano/harness-protocol"

export type HttpToolClientOptions = {
  agentId: string
  endpoint: string
  capabilities?: Iterable<ToolCapability>
  workspace?: WorkspaceDescriptor | null
  fetchImpl?: typeof fetch
  authToken?: string
}

export type HttpToolClientStatus = {
  connected: boolean
  agentId: string
  clientId: string
  capabilities: ToolCapability[]
  workspace: WorkspaceDescriptor | null
  lastSeenAt?: string
  pendingInvocations: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 10 * 60_000

function normalizeEndpoint(value: string): string {
  const endpoint = value.trim().replace(/\/+$/, "")
  if (!endpoint) throw new Error("client endpoint is required")
  const url = new URL(endpoint)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("client endpoint must be an HTTP(S) URL without credentials")
  }
  return endpoint
}

function errorResult(invocation: ToolInvocation, error: unknown): ClientToolResult {
  return {
    type: "tool.result",
    invocationId: invocation.invocationId,
    agentId: invocation.agentId,
    status: "error",
    output: `error: ${error instanceof Error ? error.message : String(error)}`,
    completedAt: new Date().toISOString(),
  }
}

async function readOutputStream(
  response: Response,
  onOutput: (chunk: string) => void,
): Promise<unknown> {
  if (!response.body) throw new Error("client returned an empty output stream")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let result: unknown

  const consume = (line: string): void => {
    if (!line.trim()) return
    const record = JSON.parse(line) as { type?: unknown; output?: unknown; result?: unknown; error?: unknown }
    if (record.type === "tool.output" && typeof record.output === "string") {
      try { onOutput(record.output) } catch {}
      return
    }
    if (record.type === "tool.result") {
      result = record.result
      return
    }
    if (record.type === "transport.error") throw new Error(String(record.error ?? "tool output stream failed"))
    throw new Error("client returned an invalid output stream record")
  }

  while (true) {
    const { done, value } = await reader.read()
    pending += decoder.decode(value, { stream: !done })
    let newline = pending.indexOf("\n")
    while (newline >= 0) {
      consume(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
      newline = pending.indexOf("\n")
    }
    if (done) break
  }
  consume(pending)
  if (result === undefined) throw new Error("client output stream ended without a tool result")
  return result
}

export class HttpToolClient implements ClientToolExecutor {
  private readonly agentId: string
  private readonly endpoint: string
  private readonly fetchImpl: typeof fetch
  private readonly authHeaders: Record<string, string>
  private capabilities: ToolCapability[]
  private workspace: WorkspaceDescriptor | null
  private connected = false
  private lastSeenAt: string | undefined
  private pendingInvocations = 0

  constructor(options: HttpToolClientOptions) {
    this.agentId = options.agentId.trim()
    if (!this.agentId) throw new Error("agent id is required")
    this.endpoint = normalizeEndpoint(options.endpoint)
    this.fetchImpl = options.fetchImpl ?? fetch
    const token = options.authToken?.trim()
    this.authHeaders = token ? { authorization: `Bearer ${token}` } : {}
    this.capabilities = [...new Set(options.capabilities ?? CLIENT_TOOL_NAMES)]
    this.workspace = options.workspace ? { ...options.workspace } : null
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("client connection aborted")
    const timeout = AbortSignal.timeout(2_000)
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const response = await this.fetchImpl(`${this.endpoint}/health`, { headers: this.authHeaders, signal: requestSignal })
      if (!response.ok) return
      const body = await response.json() as { capabilities?: unknown; workspace?: unknown }
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("client connection aborted")
      if (Array.isArray(body.capabilities)) {
        const capabilities = body.capabilities.filter((item): item is ToolCapability =>
          typeof item === "string" && (CLIENT_TOOL_NAMES as readonly string[]).includes(item),
        )
        if (capabilities.length > 0) this.capabilities = [...new Set(capabilities)]
      }
      if (body.workspace && typeof body.workspace === "object") {
        const workspace = body.workspace as Partial<WorkspaceDescriptor>
        if (typeof workspace.id === "string" && typeof workspace.root === "string") this.workspace = workspace as WorkspaceDescriptor
      }
      this.markConnected()
    } catch (error) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("client connection aborted")
      this.connected = false
    }
  }

  async stop(): Promise<void> {}

  getCapabilities(): ToolCapability[] {
    return [...this.capabilities]
  }

  getWorkspace(): WorkspaceDescriptor | null {
    return this.workspace ? { ...this.workspace } : null
  }

  status(): HttpToolClientStatus {
    return {
      connected: this.connected,
      agentId: this.agentId,
      clientId: this.endpoint,
      capabilities: this.getCapabilities(),
      workspace: this.getWorkspace(),
      ...(this.lastSeenAt ? { lastSeenAt: this.lastSeenAt } : {}),
      pendingInvocations: this.pendingInvocations,
    }
  }

  async execute(input: {
    agentId: string
    tool: ClientToolName
    args: Record<string, unknown>
    timeoutMs?: number
    signal?: AbortSignal
    onOutput?: (chunk: string) => void
  }): Promise<ClientToolResult> {
    const now = Date.now()
    const timeoutMs = Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Math.trunc(input.timeoutMs ?? DEFAULT_TIMEOUT_MS)))
    const invocation: ToolInvocation = {
      type: "tool.call",
      invocationId: randomUUID(),
      agentId: input.agentId,
      tool: input.tool,
      args: input.args,
      issuedAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + timeoutMs).toISOString(),
    }
    if (input.agentId !== this.agentId) return errorResult(invocation, "client is configured for a different agent")
    if (!this.capabilities.includes(input.tool)) return errorResult(invocation, `client does not expose ${input.tool}`)

    this.pendingInvocations += 1
    try {
      const response = await this.fetchImpl(`${this.endpoint}/tools/${encodeURIComponent(input.tool)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(input.onOutput ? { accept: "application/x-ndjson" } : {}),
          ...this.authHeaders,
        },
        body: JSON.stringify(invocation),
        signal: input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs + 1_000)])
          : AbortSignal.timeout(timeoutMs + 1_000),
      })
      const streamed = response.ok && response.headers.get("content-type")?.includes("application/x-ndjson") === true
      const raw = streamed && input.onOutput
        ? await readOutputStream(response, input.onOutput)
        : await response.json().catch(() => null)
      if (!response.ok) {
        const message = raw && typeof raw === "object" && "error" in raw ? String(raw.error) : `${response.status} ${response.statusText}`
        throw new Error(message)
      }
      const result = parseClientToolResult(raw)
      if (!result || result.invocationId !== invocation.invocationId || result.agentId !== this.agentId) {
        throw new Error("client returned an invalid tool result")
      }
      this.markConnected()
      return result
    } catch (error) {
      if (!input.signal?.aborted) this.connected = false
      return {
        ...errorResult(invocation, error),
        ...(input.signal?.aborted ? { status: "cancelled" as const } : {}),
      }
    } finally {
      this.pendingInvocations -= 1
    }
  }

  private markConnected(): void {
    this.connected = true
    this.lastSeenAt = new Date().toISOString()
  }
}
