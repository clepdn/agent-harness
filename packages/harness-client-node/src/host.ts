import path from "node:path"
import type { ClientToolHost } from "@nano/harness-core"
import {
  isToolCapability,
  type ClientImageArtifact,
  type ClientToolName,
  type ClientToolResult,
  type ToolCapability,
  type ToolInvocation,
  type WorkspaceDescriptor,
} from "@nano/harness-protocol"
import {
  CLIENT_HOME,
  CLIENT_WORKSPACE_ROOT,
  IMAGE_ROOT,
  MAX_RESULT_BYTES,
  NODE_TOOL_RUNTIME_GENERATION,
  USE_DOCKER_SHELL,
  configureNodeToolRuntime,
  type NodeToolRuntimeOptions,
} from "./config.js"
import { closeBash, currentWorkingDirectory, openBash } from "./shell.js"
import { editFile, readFile, readFileBytes, readImageForModel, runCommand } from "./tools.js"
import { executeComputerAction, parseComputerAction } from "./computer.js"
import { hashlineEdit, hashlineRead } from "./hashline/index.js"

export type NodeToolHostOptions = {
  capabilities?: Iterable<ToolCapability>
  workspace?: Partial<WorkspaceDescriptor>
  runtime?: NodeToolRuntimeOptions
  /**
   * Serve `read_file`/`edit_file` with hash-anchored line addressing. Requires
   * direct filesystem access, so it is unavailable behind the Docker shell.
   */
  hashline?: boolean
}

const ALL_CAPABILITIES: ToolCapability[] = ["shell", "read_file", "edit_file", "image_tool", "computer", "read_bytes"]

export function parseToolCapabilities(value?: string): ToolCapability[] {
  const raw = value?.trim()
  if (!raw) return [...ALL_CAPABILITIES]
  const requested = raw.split(",").map((item) => item.trim()).filter(Boolean)
  const unknown = requested.filter((item) => !isToolCapability(item))
  if (unknown.length > 0) throw new Error(`unknown client capabilities: ${unknown.join(", ")}`)
  if (requested.length === 0) throw new Error("at least one client capability is required")
  return [...new Set(requested as ToolCapability[])]
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

function boundedText(output: string): string {
  const bytes = Buffer.from(output, "utf8")
  if (bytes.length <= MAX_RESULT_BYTES) return output
  const prefix = bytes.subarray(0, MAX_RESULT_BYTES).toString("utf8").replace(/\uFFFD$/, "")
  return `${prefix}\n[truncated at ${MAX_RESULT_BYTES} bytes for transport]`
}

export class NodeToolHost implements ClientToolHost {
  private readonly capabilities: ToolCapability[]
  private readonly workspace: WorkspaceDescriptor
  private readonly runtimeGeneration: number
  private readonly hashline: boolean
  private started = false

  constructor(options: NodeToolHostOptions = {}) {
    const workspaceRoot = options.runtime?.workspaceRoot ?? options.workspace?.root
    const home = options.runtime?.home ?? options.workspace?.home
    const imageRoot = options.runtime?.imageRoot ?? options.workspace?.imageRoot
    this.runtimeGeneration = configureNodeToolRuntime({
      ...options.runtime,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(home ? { home } : {}),
      ...(imageRoot ? { imageRoot } : {}),
    })
    this.capabilities = [...new Set(options.capabilities ?? parseToolCapabilities(process.env.HARNESS_CLIENT_CAPABILITIES))]
    if (this.capabilities.length === 0) throw new Error("at least one client capability is required")
    // Hashline reads and writes the filesystem directly, so the Docker shell —
    // where the files live inside the container — cannot serve it.
    this.hashline =
      (options.hashline ?? process.env.HARNESS_HASHLINE?.trim().toLowerCase() === "true") && !USE_DOCKER_SHELL
    this.workspace = {
      id: options.workspace?.id?.trim() || path.basename(CLIENT_WORKSPACE_ROOT) || "workspace",
      root: CLIENT_WORKSPACE_ROOT,
      home: CLIENT_HOME,
      imageRoot: IMAGE_ROOT,
      platform: options.workspace?.platform?.trim() || process.platform,
      persistentShell: this.capabilities.includes("shell"),
      hashline: this.hashline,
    }
  }

  getCapabilities(): ToolCapability[] {
    return [...this.capabilities]
  }

  getWorkspace(): WorkspaceDescriptor {
    return { ...this.workspace }
  }

  async start(): Promise<void> {
    if (this.started) return
    this.assertActiveRuntime()
    if (this.capabilities.includes("shell")) await openBash()
    this.started = true
  }

  async stop(): Promise<void> {
    if (this.runtimeGeneration === NODE_TOOL_RUNTIME_GENERATION) closeBash()
    this.started = false
  }

  async execute(invocation: ToolInvocation): Promise<ClientToolResult> {
    if (!this.capabilities.includes(invocation.tool)) {
      return errorResult(invocation, new Error(`client does not expose ${invocation.tool}`))
    }
    if (Date.now() >= Date.parse(invocation.deadlineAt)) {
      return {
        ...errorResult(invocation, new Error("tool call expired before execution")),
        status: "cancelled",
      }
    }

    try {
      this.assertActiveRuntime()
      await this.start()
      const output = await this.executeTool(invocation.tool, invocation.args)
      const artifact =
        typeof output === "string"
          ? { output: boundedText(output) }
          : invocation.tool === "read_bytes"
            ? { file: output }
            : { image: output }
      return {
        type: "tool.result",
        invocationId: invocation.invocationId,
        agentId: invocation.agentId,
        status: "ok",
        ...artifact,
        completedAt: new Date().toISOString(),
      }
    } catch (error) {
      return errorResult(invocation, error)
    }
  }

  private assertActiveRuntime(): void {
    if (this.runtimeGeneration !== NODE_TOOL_RUNTIME_GENERATION) {
      throw new Error("this NodeToolHost was superseded by another host in the same process")
    }
  }

  private async executeTool(tool: ClientToolName, args: Record<string, unknown>): Promise<string | ClientImageArtifact> {
    switch (tool) {
      case "shell": {
        const output = await runCommand(
          String(args.command ?? ""),
          typeof args.max_lines === "number" ? args.max_lines : undefined,
          typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
        )
        return output || "(no output)"
      }
      case "read_file": {
        if (this.hashline) {
          const region = hashlineRead(
            String(args.path ?? ""),
            typeof args.start_line === "number" ? args.start_line : 1,
            typeof args.end_line === "number" ? args.end_line : undefined,
            await currentWorkingDirectory(),
          )
          return `[${region.startLine}-${region.endLine} of ${region.totalLines}]\n${region.content}`
        }
        const output = await readFile(
          String(args.path ?? ""),
          typeof args.start_line === "number" ? args.start_line : undefined,
          typeof args.end_line === "number" ? args.end_line : undefined,
          typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
        )
        return output || "(empty file)"
      }
      case "edit_file": {
        if (this.hashline && Array.isArray(args.edits)) {
          const result = await hashlineEdit(
            String(args.path ?? ""),
            args.edits as Parameters<typeof hashlineEdit>[1],
            await currentWorkingDirectory(),
          )
          if (!result.success) throw new Error(result.message)
          return result.preview ? `${result.message}\n${result.preview}` : result.message
        }
        const result = await editFile(
          String(args.path ?? ""),
          String(args.old_text ?? ""),
          String(args.new_text ?? ""),
          typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
        )
        if (!result.ok) throw new Error(result.message)
        return result.message
      }
      case "image_tool": {
        return readImageForModel(
          String(args.path ?? ""),
          typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
        )
      }
      case "computer": {
        return executeComputerAction(parseComputerAction(args))
      }
      case "read_bytes": {
        return readFileBytes(
          String(args.path ?? ""),
          typeof args.max_bytes === "number" ? args.max_bytes : undefined,
          typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
        )
      }
    }
  }
}
