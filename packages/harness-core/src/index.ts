import type {
  ClientToolName,
  ClientToolResult,
  ToolCapability,
  ToolInvocation,
  WorkspaceDescriptor,
} from "@nano/harness-protocol"

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonSchema = { [key: string]: JsonValue }

export type ToolDefinition = {
  type: "function"
  function: {
    name: string
    description: string
    parameters: JsonSchema
  }
}

export interface ClientToolExecutor {
  getCapabilities(): ToolCapability[]
  getWorkspace(): WorkspaceDescriptor | null
  execute(input: {
    agentId: string
    tool: ClientToolName
    args: Record<string, unknown>
    timeoutMs?: number
    signal?: AbortSignal
    /** Receives shell output incrementally while the invocation is running. */
    onOutput?: (chunk: string) => void
  }): Promise<ClientToolResult>
}

export interface ClientToolHost {
  start(): Promise<void>
  stop(): Promise<void>
  getCapabilities(): ToolCapability[]
  getWorkspace(): WorkspaceDescriptor
  execute(
    invocation: ToolInvocation,
    signal?: AbortSignal,
    onOutput?: (chunk: string) => void,
  ): Promise<ClientToolResult>
}

export type ClientToolCatalogOptions = {
  clientCapabilities?: Iterable<ToolCapability>
  workspace?: WorkspaceDescriptor | null
}

const functionTool = (name: ClientToolName, description: string, parameters: JsonSchema): ToolDefinition => ({
  type: "function",
  function: { name, description, parameters },
})

export type ReadFileToolDefinitionOptions = {
  hashline?: boolean
  memory?: boolean
}

export function createReadFileToolDefinition(
  options: ReadFileToolDefinitionOptions = {},
): ToolDefinition {
  const target = options.memory
    ? "Read a client file or directory, or a server-owned memory:// resource."
    : "Read a file or list a directory resolved by the attached client."
  const fileBehavior = options.hashline
    ? `${options.memory ? "Text file" : "Client file"} lines are prefixed with \`LINE#HASH: \`, where HASH anchors that line for edit_file. The prefix is display only — never include it in edit payloads.`
    : "File reads accept optional inclusive line bounds."
  const memoryBehavior = options.memory ? " memory:// reads work without an attached client." : ""

  return functionTool(
    "read_file",
    `${target} A directory returns \`{path} is a dir\` followed by the immediate contents, like \`ls\`. ${fileBehavior}${memoryBehavior}`,
    {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: options.memory ? "A client path or memory:// URI." : "A path resolved by the attached client.",
        },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
      },
      required: ["path"],
    },
  )
}

export function createClientToolCatalog(options: ClientToolCatalogOptions = {}): ToolDefinition[] {
  const capabilities = new Set(options.clientCapabilities ?? [])
  const imageRoot = options.workspace?.imageRoot || options.workspace?.root || "the attached client workspace"
  const hashline = options.workspace?.hashline === true
  const tools: ToolDefinition[] = []

  if (capabilities.has("shell")) {
    tools.push(
      functionTool(
        "shell",
        "Execute a bash command in a fresh process in the attached client workspace. Each call starts from the workspace root with a clean shell; set pty=true only when the command requires terminal semantics. Commands still running after 120 seconds detach into a background job and return a job id.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            command: { type: "string" },
            max_lines: { type: "integer", minimum: 1, description: "Maximum lines to return." },
            timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
            pty: { type: "boolean", description: "Allocate a fresh PTY for this command. Defaults to false." },
          },
          required: ["command"],
        },
      ),
    )
  }

  if (capabilities.has("read_file")) {
    tools.push(createReadFileToolDefinition({ hashline }))
  }

  if (capabilities.has("edit_file")) {
    tools.push(
      hashline
        ? functionTool(
            "edit_file",
            "Apply hash-anchored edits to a file resolved by the attached client. Anchors are `LINE#HASH` strings copied from a recent read_file; they are verified before the write, so a stale anchor fails instead of corrupting the file.",
            {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                edits: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      op: { type: "string", enum: ["replace", "append", "prepend", "replace_text"] },
                      pos: { type: "string", description: "Anchor such as 42#KT. Required for replace; omit on append/prepend to target the file boundary." },
                      end: { type: "string", description: "Closing anchor for an inclusive replace range." },
                      lines: { type: "array", items: { type: "string" }, description: "Literal replacement lines, without LINE#HASH prefixes." },
                      oldText: { type: "string", description: "replace_text only: exact text to replace, which must occur once." },
                      newText: { type: "string", description: "replace_text only: replacement text." },
                    },
                    required: ["op"],
                  },
                },
                timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
              },
              required: ["path", "edits"],
            },
          )
        : functionTool(
            "edit_file",
            "Replace one exact text occurrence in a file resolved by the attached client.",
            {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                old_text: { type: "string", minLength: 1 },
                new_text: { type: "string" },
                timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
              },
              required: ["path", "old_text", "new_text"],
            },
          ),
    )
  }

  if (capabilities.has("image_tool")) {
    tools.push(
      functionTool(
        "image_tool",
        `Attach a bounded image from ${imageRoot}.`,
        {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            note: { type: "string" },
            detail: { type: "string", enum: ["auto", "low", "high"] },
            timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
          },
          required: ["path"],
        },
      ),
    )
  }

  return tools
}
