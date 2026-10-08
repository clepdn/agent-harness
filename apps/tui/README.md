# @nano/tui — direct terminal chat client

A Claude-Code-style terminal chat client that connects to nano through either
a selected **worker** or the outer multi-agent control server plus `--agent`.
It mounts your current working directory into that worker so nano runs tools
(shell, file read/edit, image) directly against your files — no upload, no
catbox, no abstraction.

The outer multi-agent control server and each worker are separate HTTP servers.
`nano-tui --control` may target a worker directly, or the control server when
`--agent` selects the worker.

## how it works

```
┌────────────────────────┐         ┌──────────────────────────────┐
│  nano-tui (your shell)  │         │   selected worker (nano)       │
│                         │         │                               │
│  ┌───────────────────┐  │  1. POST /client/connect (handshake)   │
│  │ tool executor     │◀─┼─────────┤  SwitchableToolClient mounts   │
│  │ workspace = $PWD  │  │  3. tool │  your executor as active      │
│  │                   │  │  calls   │  target                        │
│  └───────────────────┘  │◀─────────┤                               │
│                         │         │                               │
│  chat UI ───────────────┼─2. POST /trigger/chat ──▶ runner        │
│         ◀───────────────┼─── GET /chat/stream (SSE) ──────────────┤
└────────────────────────┘         └──────────────────────────────┘
```

1. On start, `nano-tui` boots an in-process tool **executor** bound to your
   working directory.
2. It performs `/client/connect` on the selected worker, either directly or
   through the control server's `/agents/:id/client/connect` proxy. The worker's
   `SwitchableToolClient` swaps tool routing from its default client to yours.
3. You chat. Nano's tool calls are routed to *your* executor, so `shell` runs in
   your `$PWD`, `read_file`/`edit_file` touch your files, etc.
4. On exit (Ctrl-C / `/quit`) the client disconnects and the worker reverts to
   its default client.

The executor and chat lifecycle are native Cordis plugins in
`@nano/plugin-tui-executor` and `@nano/plugin-tui-rpc-chat`. The terminal host
composes them through the same public `ctx.plugin()` and `ctx.effect()` APIs
available to third-party plugins, using `@deepseek-ai/cordis@4.0.4`.

## usage

```sh
# direct worker URL:
npm run start --workspace @nano/tui -- --control http://<worker-host>:<worker-port>

# common flags
--control <url>       worker or control plane base URL (env NANO_CONTROL_URL)
--agent <id>          target agent on a multi-agent control plane (env NANO_AGENT_ID)
--workspace <dir>     dir to mount (default: cwd)
--advertise <url>     callback URL the worker can reach
--listen-host <host>  0.0.0.0 to accept calls from a remote worker
--tool-port <n>       executor port (default: ephemeral)
--capabilities <csv>  restrict tools (default: all)
--hashline            enable hashline file editing
```

### local (same host as worker)

The executor binds `127.0.0.1` and advertises its own address — nothing else
to configure.

### remote worker (control server on homura, TUI on your laptop)

Forward the outer control server and select its worker explicitly. For the
deployed homura layout where the outer server is `4220` and agent `nano` is
served by that control plane:

```sh
ssh -N -L 4220:127.0.0.1:4220 homura
npm run start --workspace @nano/tui -- --control http://127.0.0.1:4220 --agent nano \
  --listen-host 0.0.0.0 --advertise http://<your-mesh-ip>:4221 --tool-port 4221
```

You can instead tunnel the worker port and omit `--agent`. In either form, the
executor callback must be reachable from the worker; use a trusted private
address or a matching reverse tunnel. Worker ports default to the outer control
port plus the agent file's sorted position unless the agent declares `port`.

## server side

The outer control server exposes `/agents/:id/...` routes for agent selection,
status, events, streams, and client connect/disconnect. The selected worker
also exposes the direct routes:

- `POST /client/connect` `{ endpoint, workspace?, capabilities? }` — mount a
  connecting client's executor as the active tool target. Performs an executor
  health handshake; returns `502` if unreachable.
- `POST /client/disconnect` — revert to the default client.
- `POST /trigger/chat` and `GET /chat/stream` — chat input and SSE output.
- `GET /awp/client/status` — current active client status.

Routing is handled by `SwitchableToolClient`
(`packages/nano-runtime-api/src/client/switchable.ts`), which delegates to the
default client until a remote one connects.
