# Niri

## Run the server

```sh
npm ci
cp agents/mira.example.toml agents/mira.toml
chmod 600 agents/mira.toml
# edit agents/mira.toml
npm start
```

The server reads every `.toml` file in `agents/`. Files ending in `.example.toml` are skipped.

The web dashboard is served by the control plane at `/ui/` on the same port.
Nix packages include the built UI automatically. With `services.nano.agents`
configured, open `http://<control-host>:<services.nano.controlPort>/ui/`
(the default control port is `3000`). No separate web service is needed.
For a source checkout, `npm start` builds the UI before starting the server;
you can also build it explicitly with `npm run build:web`.

## Run a client

```sh
cd apps/client
npm run start
```

The client listens on `0.0.0.0:3002` and runs `shell`, `read_file`, `edit_file`, and `image_tool` from the client's home directory.

## Discord controls

The configured Discord owner can use `/fast` to toggle priority service for
Codex models, or `/fast enabled:true` and `/fast enabled:false` to set it
explicitly. `/model info` shows the current setting. Changes apply to subsequent
Codex requests (including subagents and summaries); off uses the default service
tier. The setting is local to the agent runtime and resets to off on restart.

## Agent memory

Memory lives on the server under the agent's `home`, separate from any attached client:

| Path | Contents |
| --- | --- |
| `<home>/soul.md` | The agent's identity and enduring self-description |
| `<home>/memories/` | Long-term Markdown memories, including core notes, journals, and people files |
| `<home>/state/` | Session, rest snapshot, and failover state |
| `<home>/nano.db` | The searchable memory index and other durable runtime data |

For example, an agent with `home: /home/nano` keeps long-term memories in `/home/nano/memories`.

For routine maintenance, ask the agent to inspect, organize, or repair their own memories using the memory tools. Treat `soul.md` and `memories/` like a private diary: do not read or change them unless the agent asks; it's weird if you do. For backup or recovery, stop the worker and preserve the entire agent home rather than copying only the Markdown files.

## Agent TOML specification

One file in `agents/` is one agent. Files ending in `.example.toml` are skipped.
Keys are literal — write nested values as tables, never as dotted keys.

An agent file describes only what the control plane owns. Everything the agent
*runs on* — model, fallback, tools, context, Discord, subagents — lives in the
runtime TOML named by `config`, in the same format a standalone
`nano --config …` run reads. There is one config dialect, and both ways of
starting a worker feed it the identical file.

### Top level

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `id` | string matching `[a-zA-Z0-9_-]+` | no | filename without `.toml` |
| `name` | string | no | `id` |
| `port` | integer `1..65535` | no | control port plus the file's sorted position |
| `home` | path | no | `data/agents/<id>` |
| `client` | `local` or an HTTP(S) URL | yes | — |
| `workspace` | path | no | repository root; applies to `client = "local"` |
| `config` | path, or a list of paths | no | — |
| `secrets` | path | no | — |
| `[settings]` | table | no | `{}` |

Relative `home`, `workspace`, `config`, and `secrets` paths resolve from the
repository root. A `config` or `secrets` path that does not exist fails startup.

### `config` and `secrets`

The worker is spawned with these as `--config` and `--secrets` flags. `config`
may be a list: each file is deep-merged over the previous one, so several
agents can share a base file and layer their own differences on top. `secrets`
is merged last, so a key set in both resolves to the secrets value.

```toml
config = ["/etc/nano/config.toml", "/etc/nano/agents/mira.toml"]
secrets = "/run/agenix/nanoSecrets"
```

Credentials reach the worker as files, never as environment variables — the
agent's own shell tool inherits that environment.

### `[settings]`

`settings` accepts string, number, and boolean values keyed by uppercase
runtime setting names, and becomes the worker's environment. It is for the
settings that are genuinely environment-shaped; anything the runtime reads from
TOML belongs in `config`. Names the server manages — `PORT`, `HOME`,
`NANO_CONFIG`, `NANO_SECRETS`, and the `NANO_*` prefixes — are rejected.

> **TODO:** Promote the remaining active settings into first-party TOML sections for tools, context management, Discord batching/cooldowns, state, and bridges. Remove the settings that have no runtime reader.

#### Tools and model calls

| Setting | Staged value | Purpose |
| --- | --- | --- |
| `IMAGE_TOOL_MAX_BYTES` | `1000000` | Maximum image size accepted by the image tool. |
| `PRIMARY_TOOL_CHOICE` | `auto` | Tool-choice mode for primary model requests: `required`, `auto`, or `none`. |
| `FALLBACK_TOOL_CHOICE` | `auto` | Tool-choice mode for fallback model requests. |
| `FALLBACK_ENFORCE_CONTEXT_LIMIT` | `false` | Enforce the configured fallback context limit before sending a request. |

#### Context management

| Setting | Staged value | Purpose |
| --- | --- | --- |
| `CONTEXT_COMPACT_TRIGGER_TOKENS` | `100000` | Start context compaction at this token estimate. |
| `TOKEN_NUDGE_THRESHOLD` | `120000` | No current runtime reader. |
| `CONTEXT_COMPACT_TARGET_TOKENS` | `65000` | No current runtime reader. |
| `CONTEXT_COMPACT_RECENT_MESSAGES` | `80` | No current runtime reader. |
| `CONTEXT_COMPACT_CHUNK_MESSAGES` | `32` | No current runtime reader. |
| `CONTEXT_COMPACT_SUMMARY_MAX_CHARS` | `500000` | No current runtime reader. |

#### Discord

| Setting | Staged value | Purpose |
| --- | --- | --- |
| `DISCORD_GATEWAY_TRACE` | `true` | Log gateway tracing details. |
| `DISCORD_GATEWAY_RAW_FALLBACK` | `true` | Use raw gateway events when the normal event path cannot handle an event. |
| `DISCORD_BATCH_INTERVAL_MS` | `8000` | Interval between Discord batch checks. |
| `DISCORD_BATCH_ONLY_CONFIGURED` | `true` | Limit batches to DMs and configured scan channels. |
| `DISCORD_PENDING_AUTO_SEEN_MINUTES` | `10` | Mark pending messages seen after this many minutes. |
| `DISCORD_BATCH_SCAN` | `true` | Scan configured channels before building each batch. |
| `DISCORD_BATCH_MAX_MESSAGES` | `120` | Maximum messages included in one batch. |
| `COOLDOWN_CHANNELS` | `channelId,2000,0400` | Channel response windows as repeated `channelId,startHHMM,endHHMM` triples. |
| `COOLDOWN_TZ` | `America/New_York` | Time zone used for cooldown windows. |
| `DISCORD_WAKE_ON_DM` | `true` | No current runtime reader. |
| `DISCORD_WHITELIST` | Discord user ids | No current runtime reader; use `discord.dmWhitelist`. |

#### State and process

| Setting | Staged value | Purpose |
| --- | --- | --- |
| `NANO_MIGRATE_LEGACY_STATE` | `true` | Copy root-level session snapshots into the agent state directory once. |
| `AGENT_UID` | `1001` | No worker runtime reader; used only by the Docker build and Compose configuration. |
| `AGENT_GID` | `1001` | No worker runtime reader; used only by the Docker build and Compose configuration. |

#### Bridges

| Setting | Staged value | Purpose |
| --- | --- | --- |
| `ANTIGRAVITY_BRIDGE_ENABLED` | Niri: `false`; Lyra: `true` | Start the Antigravity bridge. |
| `ANTIGRAVITY_BRIDGE_PORT` | `8000` | Antigravity bridge loopback port. |
| `ANTIGRAVITY_BINARY_PATH` | `/home/nano/.local/bin/agy` | Antigravity executable. |
| `CODEX_BRIDGE_ENABLED` | Niri: `true`; Lyra: `false` | Start the Codex bridge. |
| `CODEX_BRIDGE_PORT` | `8001` | Codex bridge loopback port. |
| `CODEX_BRIDGE_MODEL` | `gpt-5.6-sol` | Model presented by the Codex bridge. |
| `CODEX_BRIDGE_REASONING_EFFORT` | `low` | Codex bridge reasoning effort. |

Agent ids, worker ports, canonical home paths, Discord tokens, and enabled bridge ports must be unique.

Agent TOML files contain credentials and should use mode `0600`. Tool-client endpoints should stay on loopback or a trusted private network.

## Check the repository

```sh
npm run typecheck
npm test
npm run build
```
