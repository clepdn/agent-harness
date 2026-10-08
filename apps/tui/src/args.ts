export type TuiArgs = {
  control: string
  agent?: string
  gatewayTokenFile?: string
  workspace: string
  advertise?: string
  listenHost: string
  toolPort: number
  capabilities?: string
  hashline: boolean
  help: boolean
}
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  if (i >= 0) return process.argv[i + 1]
  return process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
}

export function parseArgs(): TuiArgs {
  return {
    control: (flag("--control") ?? process.env.NANO_CONTROL_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, ""),
    agent: flag("--agent") ?? process.env.NANO_AGENT_ID,
    gatewayTokenFile: flag("--gateway-token-file"),
    workspace: flag("--workspace") ?? process.cwd(),
    advertise: flag("--advertise") ?? process.env.NANO_ADVERTISE_URL,
    listenHost: flag("--listen-host") ?? "127.0.0.1",
    toolPort: Number.parseInt(flag("--tool-port") ?? "0", 10),
    capabilities: flag("--capabilities"),
    hashline: process.argv.includes("--hashline"),
    help: process.argv.includes("--help") || process.argv.includes("-h"),
  }
}

export const HELP = `nano-tui — direct terminal chat client for nano

Usage: nano-tui [options]

  --control <url>       worker or control plane base URL (default http://127.0.0.1:3001, env NANO_CONTROL_URL)
  --agent <id>          agent ID when connecting through a multi-agent control plane
  --workspace <dir>     directory to mount as the tool workspace (default: cwd)
  --advertise <url>     URL the worker should call back on (default: the
                        executor's own bound address; set this when the worker
                        is on another host, e.g. http://<your-ip>:<port>)
  --listen-host <host>  host the executor binds (default 127.0.0.1; use 0.0.0.0
                        to accept calls from a remote worker)
  --tool-port <n>       executor port (default 0 = ephemeral)
  --capabilities <csv>  restrict tool capabilities (default: all)
  --gateway-token-file <path>  gateway token file (memory-only; env NANO_RPC_TOKEN fallback)
  --hashline            enable hashline file editing
  -h, --help            show this help

Use a worker URL directly, or use the outer multi-agent control URL together
with --agent. On start this client mounts your working directory via the
selected worker's /client/connect route, so nano runs tools against your files.
Type a message and press Enter. Ctrl-C to quit (auto-disconnects).
`

export function handshakeErrorMessage(
  status: number,
  statusText: string,
  body: string,
  control: string,
  agent?: string,
): string {
  const detail = body.trim()
  if (status === 404) {
    const target = agent ? `${control} for agent ${agent}` : control
    const guidance = agent
      ? " Verify that --agent names an agent served by this control plane."
      : " If this is the outer multi-agent control URL, pass --agent; otherwise use the selected worker URL."
    return `handshake failed (404) at ${target}.${guidance}${detail ? ` Server response: ${detail}` : ""}`
  }
  const statusLabel = `${status} ${statusText}`.trim()
  return `handshake failed (${statusLabel}): ${detail}`
}
