#!/usr/bin/env -S npx tsx
import readline from "node:readline"
import { createChatClient, type StreamEvent } from "@nano/chat-client"
import { parseArgs, HELP, handshakeErrorMessage } from "./args.js"
import { startExecutor, type RunningExecutor } from "./executor.js"
import {
  bold, cyan, dim, gray, green, magenta, red, yellow,
  HIDE_CURSOR, SHOW_CURSOR, clearLine,
} from "./theme.js"

const args = parseArgs()
if (args.help) {
  process.stdout.write(HELP)
  process.exit(0)
}

function banner(text: string): void {
  process.stdout.write(`${clearLine}${text}\n`)
}

function controlUrl(path: string): string {
  return args.agent
    ? `${args.control}/agents/${encodeURIComponent(args.agent)}${path}`
    : `${args.control}${path}`
}

async function connect(executor: RunningExecutor): Promise<void> {
  const endpoint = args.advertise?.replace(/\/+$/, "") ?? executor.url
  const res = await fetch(controlUrl("/client/connect"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      endpoint,
      workspace: { id: executor.workspaceRoot.split("/").pop() || "workspace", root: executor.workspaceRoot },
      capabilities: executor.capabilities,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(handshakeErrorMessage(res.status, res.statusText, body, args.control, args.agent))
  }
}

async function disconnect(): Promise<void> {
  try {
    await fetch(controlUrl("/client/disconnect"), { method: "POST" })
  } catch {}
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
  banner(dim(`nano-tui → ${args.control}${args.agent ? ` (${args.agent})` : ""}`))
  banner(dim("starting local tool executor…"))

  let executor: RunningExecutor
  try {
    executor = await startExecutor({
      workspaceRoot: args.workspace,
      listenHost: args.listenHost,
      port: args.toolPort,
      ...(args.capabilities ? { capabilities: args.capabilities } : {}),
      hashline: args.hashline,
    })
  } catch (error) {
    banner(red(`could not start executor: ${(error as Error).message}`))
    process.exit(1)
  }

  banner(`${green("✓")} workspace ${bold(executor.workspaceRoot)} mounted (${executor.capabilities.length} tools)`)

  try {
    await connect(executor)
  } catch (error) {
    banner(red(`✗ ${(error as Error).message}`))
    await executor.stop()
    process.exit(1)
  }
  banner(`${green("✓")} connected — nano now runs tools against your files`)
  banner(gray("type a message, Enter to send · Ctrl-C to quit\n"))

  const chat = createChatClient({ baseUrl: args.control, ...(args.agent ? { agentId: args.agent } : {}) })
  const streamState = { streaming: false }
  const abort = new AbortController()

  // Background: consume the SSE stream and render.
  const streamLoop = (async () => {
    for (;;) {
      try {
        await chat.stream({
          signal: abort.signal,
          onEvent: (event) => render(event, streamState),
        })
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
    abort.abort()
    await disconnect()
    await executor.stop().catch(() => {})
    await streamLoop.catch(() => {})
    process.exit(0)
  }

  rl.on("close", () => void shutdown())
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
}

main().catch((error) => {
  process.stdout.write(SHOW_CURSOR)
  console.error(red(`fatal: ${error instanceof Error ? error.message : String(error)}`))
  process.exit(1)
})
