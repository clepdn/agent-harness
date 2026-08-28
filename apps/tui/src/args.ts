export type TuiArgs = {
  control: string
  agent?: string
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
  return i >= 0 ? process.argv[i + 1] : undefined
}

export function parseArgs(): TuiArgs {
  return {
    control: (flag("--control") ?? process.env.NANO_CONTROL_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, ""),
    agent: flag("--agent") ?? process.env.NANO_AGENT_ID,
    workspace: flag("--workspace") ?? process.cwd(),
    advertise: flag("--advertise") ?? process.env.NANO_ADVERTISE_URL,
    listenHost: flag("--listen-host") ?? "127.0.0.1",
    toolPort: Number.parseInt(flag("--tool-port") ?? "0", 10),
    capabilities: flag("--capabilities"),
    hashline: process.argv.includes("--hashline"),
    help: process.argv.includes("--help") || process.argv.includes("-h"),
  }
}

export const HELP = `nano-tui — direct terminal chat client for the nano control plane

Usage: nano-tui [options]

  --control <url>       control plane base URL (default http://127.0.0.1:3001, env NANO_CONTROL_URL)
  --agent <id>          agent ID when connecting through a multi-agent control plane
  --workspace <dir>     directory to mount as the tool workspace (default: cwd)
  --advertise <url>     URL the control plane should call back on (default: the
                        executor's own bound address; set this when the control
                        plane is on another host, e.g. http://<your-ip>:<port>)
  --listen-host <host>  host the executor binds (default 127.0.0.1; use 0.0.0.0
                        to accept calls from a remote control plane)
  --tool-port <n>       executor port (default 0 = ephemeral)
  --capabilities <csv>  restrict tool capabilities (default: all)
  --hashline            enable hashline file editing
  -h, --help            show this help

On start it mounts your working directory into the control plane via the
/client/connect handshake, so nano runs tools directly against your files.
Type a message and press Enter. Ctrl-C to quit (auto-disconnects).
`
