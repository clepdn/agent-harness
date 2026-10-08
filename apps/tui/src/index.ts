#!/usr/bin/env -S npx tsx
import fs from "node:fs"
import readline from "node:readline"
import { createRpcClient } from "@nano/chat-client"
import {
  controlAgentStream,
  controlClientConnect,
  controlClientDisconnect,
  controlEnqueue,
  workerChatStream,
  workerChatSubmit,
  workerClientConnect,
  workerClientDisconnect,
} from "@nano/protocol"
import type { StreamEvent, StreamItem } from "@nano/protocol"
import { defineService, PluginBus } from "@nano/plugins"
import { parseArgs, HELP } from "./args.js"
import { startExecutor, type RunningExecutor } from "./executor.js"
import {
  bold, cyan, dim, gray, green, magenta, red, yellow,
  HIDE_CURSOR, SHOW_CURSOR, clearLine,
} from "./theme.js"
const args = parseArgs()
const gatewayToken = args.gatewayTokenFile
  ? (() => {
      try {
        const token = fs.readFileSync(args.gatewayTokenFile, "utf8").trim()
        if (!token) throw new Error("--gateway-token-file is empty")
        return token
      } catch (error) {
        throw new Error(`Unable to read --gateway-token-file: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  : process.env.NANO_RPC_TOKEN?.trim()
const rpcOptions = () => ({ url: args.control, ...(gatewayToken ? { token: gatewayToken } : {}) })
const executorResource = defineService<RunningExecutor>("nano.tui.executor")

async function connect(executor: RunningExecutor): Promise<void> {
  const endpoint = args.advertise?.replace(/\/+$/, "") ?? executor.url
  const client = createRpcClient(rpcOptions())
  try {
    if (args.agent) {
      await client.call(controlClientConnect, {
        agentId: args.agent,
        body: {
          endpoint,
          workspace: { id: executor.workspaceRoot.split("/").pop() || "workspace", root: executor.workspaceRoot },
          capabilities: executor.capabilities,
        },
      })
    } else {
      await client.call(workerClientConnect, {
        endpoint,
        workspace: { id: executor.workspaceRoot.split("/").pop() || "workspace", root: executor.workspaceRoot },
        capabilities: executor.capabilities,
      })
    }
  } finally {
    client.close()
  }
}
function banner(text: string): void {
  process.stdout.write(`${clearLine}${text}\n`)
}

function createTuiChatClient() {
  const client = createRpcClient(rpcOptions())
  const agentId = args.agent
  return {
    send: async (content: string) => {
      if (agentId) await client.call(controlEnqueue, { agentId, body: { content } })
      else await client.call(workerChatSubmit, { content })
    },
    stream: (signal: AbortSignal, onEvent: (event: StreamEvent) => void) => {
      if (!agentId) return client.stream(workerChatStream, {}, { signal, onItem: onEvent })
      return client.stream(controlAgentStream, { agentId }, {
        signal,
        onItem: (item: StreamItem<typeof controlAgentStream>) => {
          const payload = item.payload
          if (payload && typeof payload === "object" && "type" in payload) onEvent(payload as StreamEvent)
        },
      })
    },
    close: () => client.close(),
  }
}

async function disconnect(): Promise<void> {
  const client = createRpcClient(rpcOptions())
  try {
    if (args.agent) await client.call(controlClientDisconnect, { agentId: args.agent })
    else await client.call(workerClientDisconnect, {})
  } finally {
    client.close()
  }
}

/** Render a single stream event. Returns whether the prompt should redraw. */
function render(event: StreamEvent, state: { streaming: boolean }): void {
  switch (event.type) {
    case "text": {
      if (!state.streaming) {
        process.stdout.write(`${clearLine}${bold(magenta("nano"))} `)
        state.streaming = true
      }
      process.stdout.write(event.text)
      break
    }
    case "thinking": {
      // Keep thinking subtle and on its own line.
      process.stdout.write(`${clearLine}${dim(italicish(event.text))}\n`)
      break
    }
    case "tool": {
      if (state.streaming) {
        process.stdout.write("\n")
        state.streaming = false
      }
      const argStr = summarizeArgs(event.args)
      process.stdout.write(`${clearLine}${cyan("⚙")} ${bold(event.name)}${argStr ? " " + gray(argStr) : ""}\n`)
      const out = event.result?.trim()
      if (out) {
        for (const line of clip(out, 12)) process.stdout.write(`${gray("│")} ${dim(line)}\n`)
      }
      break
    }
    case "usage": {
      if (state.streaming) {
        process.stdout.write("\n")
        state.streaming = false
      }
      const t = event.totalTokens ?? 0
      const tps = event.tokensPerSecond ? ` · ${event.tokensPerSecond.toFixed(0)} tok/s` : ""
      process.stdout.write(`${clearLine}${gray(`— ${t} tokens${tps} —`)}\n`)
      break
    }
    case "user":
      // Echoed back by the stream; we already printed it locally.
      break
  }
}

function italicish(s: string): string {
  return s.length > 220 ? s.slice(0, 217) + "..." : s
}

function summarizeArgs(argsObj: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(argsObj)) {
    const val = typeof v === "string" ? v : JSON.stringify(v)
    parts.push(`${k}=${val.length > 60 ? val.slice(0, 57) + "..." : val}`)
    if (parts.join(" ").length > 100) break
  }
  return parts.join(" ")
}

function clip(text: string, maxLines: number): string[] {
  const lines = text.split("\n")
  if (lines.length <= maxLines) return lines
  return [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more lines)`]
}
async function main(): Promise<void> {
  const appBus = new PluginBus()
  try {
    await appBus.install({
      id: "nano.tui.executor",
      provides: [executorResource],
      async apply(scope) {
        const started = await startExecutor({
          workspaceRoot: args.workspace,
          listenHost: args.listenHost,
          port: args.toolPort,
          ...(args.capabilities ? { capabilities: args.capabilities } : {}),
          hashline: args.hashline,
        })
        scope.provide(executorResource, started)
        scope.own(() => started.stop())
      },
    })
  } catch (error) {
    banner(red(`could not start executor: ${(error as Error).message}`))
    await appBus.close()
    process.exit(1)
  }
  const executor = appBus.get(executorResource)
  banner(dim(`nano-tui → ${args.control}${args.agent ? ` (${args.agent})` : ""}`))
  banner(`${green("✓")} workspace ${bold(executor.workspaceRoot)} mounted (${executor.capabilities.length} tools)`)
  try {
    await connect(executor)
  } catch (error) {
    banner(red(`✗ ${(error as Error).message}`))
    await appBus.close()
    process.exit(1)
  }
  banner(`${green("✓")} connected — nano now runs tools against your files`)
  banner(gray("type a message, Enter to send · Ctrl-C to quit\n"))

  const chat = createTuiChatClient()
  const streamState = { streaming: false }
  const abort = new AbortController()
  await appBus.install({
    id: "nano.tui.rpc-chat",
    apply(scope) {
      scope.own(() => {
        abort.abort()
        chat.close()
      })
    },
  })

  const streamLoop = (async () => {
    for (;;) {
      try {
        await chat.stream(abort.signal, (event) => render(event, streamState))
        if (abort.signal.aborted) return
      } catch (error) {
        if (abort.signal.aborted) return
        banner(yellow(`stream dropped, retrying: ${(error as Error).message}`))
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  })()

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const prompt = () => {
    if (streamState.streaming) {
      process.stdout.write("\n")
      streamState.streaming = false
    }
    rl.setPrompt(`${bold(cyan("you"))} ${gray("›")} `)
    rl.prompt()
  }

  process.stdout.write(HIDE_CURSOR === "" ? "" : SHOW_CURSOR)
  prompt()

  rl.on("line", async (line) => {
    const content = line.trim()
    if (!content) return prompt()
    if (content === "/quit" || content === "/exit") return void rl.close()
    try {
      await chat.send(content)
    } catch (error) {
      banner(red(`send failed: ${(error as Error).message}`))
    }
    prompt()
  })

  const shutdown = async () => {
    process.stdout.write(SHOW_CURSOR)
    banner(dim("\ndisconnecting…"))
    await disconnect()
    await appBus.close()
    await streamLoop.catch(() => {})
    process.exit(0)
  }

  rl.on("close", () => void shutdown())
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
}

if (args.help) {
  process.stdout.write(HELP)
} else {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
