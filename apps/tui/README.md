# @nano/tui — direct terminal chat client

A Claude-Code-style terminal chat client that connects **directly** to the nano
control plane, bypassing Discord. It mounts your current working directory into
the control plane so nano runs tools (shell, file read/edit, image) directly
against your files — no upload, no catbox, no abstraction.

## how it works

```
┌────────────────────────┐         ┌──────────────────────────────┐
│  nano-tui (your shell)  │         │   control plane (nano)        │
│                         │         │                               │
│  ┌───────────────────┐  │  1. POST /client/connect (handshake)   │
│  │ tool executor     │◀─┼─────────┤  SwitchableToolClient mounts   │
│  │ (NodeToolHost)    │  │  3. tool │  your executor as active      │
│  │ workspace = $PWD  │  │  calls   │  target                        │
│  └───────────────────┘  │◀─────────┤                               │
│                         │         │                               │
│  chat UI ───────────────┼─2. POST /trigger/chat ──▶ runner        │
│         ◀───────────────┼─── GET /chat/stream (SSE) ──────────────┤
└────────────────────────┘         └──────────────────────────────┘
```

1. On start, `nano-tui` boots an in-process tool **executor** bound to your
   working directory.
2. It performs the `/client/connect` **handshake**, telling the control plane
   its executor endpoint + workspace. The control plane's `SwitchableToolClient`
   swaps tool routing from the default (local) client to yours.
3. You chat. Nano's tool calls are routed to *your* executor, so `shell` runs in
   your `$PWD`, `read_file`/`edit_file` touch your files, etc.
4. On exit (Ctrl-C / `/quit`) the client disconnects and the control plane
   reverts to its default client.

## usage

```sh
# from the directory you want nano to work in:
npm run start --workspace @nano/tui -- --control http://<control-host>:3001

# common flags
--control <url>       control plane base URL (env NANO_CONTROL_URL)
--workspace <dir>     dir to mount (default: cwd)
--advertise <url>     callback URL if the control plane is on another host
--listen-host <host>  0.0.0.0 to accept calls from a remote control plane
--tool-port <n>       executor port (default: ephemeral)
--capabilities <csv>  restrict tools (default: all)
--hashline            enable hashline file editing
```

### local (same host as control plane)

The executor binds `127.0.0.1` and advertises its own address — nothing else to
configure.

### remote (control plane on homura, you on your laptop)

Bind the executor so the control plane can reach it, and tell it what URL to
call back on:

```sh
nano-tui --control http://homura:3001 --listen-host 0.0.0.0 --advertise http://<your-ip>:<port> --tool-port 3010
```

## server side

The control plane exposes:

- `POST /client/connect` `{ endpoint, workspace?, capabilities? }` — mount a
  connecting client's executor as the active tool target. Performs an executor
  health handshake; returns `502` if unreachable.
- `POST /client/disconnect` — revert to the default client.
- `GET /awp/client/status` — current active client status.

Routing is handled by `SwitchableToolClient`
(`packages/nano-runtime/src/client/switchable.ts`), which delegates to the
default client until a remote one connects.
