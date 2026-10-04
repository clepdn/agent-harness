# Niri

## Run the server

Nix is the source configuration format. The NixOS module generates JSON directly
from `services.nano.settings` and `services.nano.agents`; see [configuration](docs/config.md).
For a source checkout:

```sh
npm ci
cp config.example.nix config.nix
cp agents/mira.example.nix agents/mira.nix
# edit both Nix files; keep credentials in a separate JSON secrets file
nix eval --json --file config.nix > config.json
nix eval --json --file agents/mira.nix > agents/mira.json
npm start -- --config config.json
```

The server reads every `.json` file in `agents/`. Files ending in `.example.json`
are skipped. Shared `server` settings control the bind address;
command-line `--host` and `--port` flags take precedence.

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
tier. The setting is local to the agent runtime and resets on restart to the
startup configuration's `fast` value (`false` by default).

`/model swap preset:<name>` changes presets through a fresh-session handoff. Discord
acknowledges the request first, then reports the completed result or an error. The
outgoing session keeps its current model settings while it receives an explicit
journal-now instruction and request to call `end_session`; normal memory and session
tools perform that work. A graceful result requires a successful `edit_file` write
to a file under `memory://journal/` before `end_session` completes.
Events arriving during the handoff are durably held in order, not injected into the outgoing context, and replayed into the fresh bootstrap before the handoff marker is cleared. The selected
preset name is persisted before that bootstrap and re-resolved against current
configuration after restart; per-preset settings come from configured values, not
mutated settings inherited from a previous runtime swap. If the saved preset no
longer resolves, startup fails rather than restoring the old selection. Credentials
and the config file are not rewritten.

For an active turn, the runner waits up to 15 seconds for a safe boundary. If a
mutating tool or compaction is still active at that boundary, the swap fails closed
and keeps the old selection. Background jobs or tools must actually unwind; cancelling
a synthetic job does not make a still-running mutation safe to overlap. Active
inference can be cancelled, with up to 5 more seconds for it to settle. Journaling
and `end_session` are limited to eight turns or 90 seconds. If generation fails,
the end is not reached, a journal write is not confirmed, or a wait blocks, the
runner reports a non-graceful result and archives raw message history in the existing
rest-context provenance snapshot before clearing session checkpoints; the fresh
bootstrap receives that archived state. Swap end skips shutdown compaction and any
secondary summary request. The overall transition is bounded to about 110 seconds
plus persistence, including any inherited frontend lane.
If the frontend inherits the main preset, both lanes are held and must reach the
safe close/archive barrier before the global selection is installed; an explicit
frontend preset is left unchanged.


`/interrupt` stops the active model generation or foreground blocking job while
keeping the session. `/discard` stops all session work, archives the raw snapshot
as `memories/discarded-{datetime}.json`, and removes it from the active runner.
`/compact` runs an immediate context compaction. `/compact force:true` requires
the dedicated `summary` model and hands its detailed play-by-play to the primary
model to journal on the next turn. Add `snapcompact:true` to preserve the discarded
span as a bitmap frame (with a text fallback if rendering is unavailable).
Shell calls still running after two minutes detach automatically; the model can
inspect their status and stdout or stop them with `job_list`, `job_status`,
`job_stdout`, and `job_cancel`.

The owner also receives a DM when a terminal model API error occurs, or when a
transient error repeats three times. Alerts are deduplicated for six hours and
include a **Mute this error forever** button. Muting is stored in `nano.db` and
applies only to that error fingerprint.

Set `frontend.enable = true` to run a second virtual nano for every model-eligible
Discord event except DMs authored by `discord.owner_id`. It sees the main soul
through a private, three-way-rebased patch and shares memories with the main agent,
but has its own session and model loop, no executor
or skill access, no owner-DM lookup access, and a durable `agent_send` /
`agent_channel` bridge to the main agent. Omit `frontend.preset` to follow the
main agent's live model; set it to a named model preset to pin a separate one.

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

The `memory_fs` tool also supports `op: "ls"` to list immediate children in server memory. Use `file_name: "memory://"` or `"."` for the root, or a relative directory path or directory `memory://` URI for a subdirectory. Results are sorted child names, with `/` on real directories; listing is non-recursive and does not read file contents. Empty directories are reported as `(empty directory)`. Listing takes no `target` and does not accept `local://`. The separate `memory://soul.md` read route is outside the `memories/` listing.

## Agent JSON specification

One file in `agents/` is one agent. Files ending in `.example.json` are skipped.
The NixOS module generates these files from `services.nano.agents`. For standalone
use, evaluate an agent Nix attribute set to JSON. JSON uses nested objects; a key
containing a dot is a literal key, not a nested setting.

An agent file describes only what the control plane owns. Everything the agent
*runs on* — model, fallback, tools, context, Discord, subagents — lives in the
runtime JSON named by `config`, in the same format a standalone
`nano --config …` run reads. There is one config dialect, and both ways of
starting a worker feed it the identical file.

### Top level

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `id` | string matching `[a-zA-Z0-9_-]+` | no | filename without `.json` |
| `name` | string | no | `id` |
| `port` | integer `1..65535` | no | control port plus the file's sorted position |
| `home` | path | no | `data/agents/<id>` |
| `client` | `local` or an HTTP(S) URL | yes | — |
| `workspace` | path | no | repository root; applies to `client = "local"` |
| `config` | path, or a list of paths | no | — |
| `secrets` | path | no | — |
| `settings` | object | no | `{}` |

Relative `home`, `workspace`, `config`, and `secrets` paths resolve from the
repository root. A `config` or `secrets` path that does not exist fails startup.

### `config` and `secrets`

The worker is spawned with these as `--config` and `--secrets` flags. `config`
may be a list: each file is deep-merged over the previous one, so several
agents can share a base file and layer their own differences on top. `secrets`
is merged last, so a key set in both resolves to the secrets value.

```nix
config = [ "/etc/nano/config.json" "/etc/nano/agents/mira.json" ];
secrets = "/run/agenix/nanoSecrets"; # JSON contents; the filename may be extensionless
```

Credentials reach the worker as files, never as environment variables — the
agent's own shell tool inherits that environment.

### `settings`

`settings` accepts string, number, and boolean values keyed by uppercase
runtime setting names, and becomes the worker's environment. It is for the
settings that are genuinely environment-shaped; anything the runtime reads from
JSON belongs in `config`. Names the server manages — `PORT`, `HOME`,
`NANO_CONFIG`, `NANO_SECRETS`, and the `NANO_*` prefixes — are rejected.

> **TODO:** Promote the remaining active settings into first-party configuration sections for tools, context management, Discord batching/cooldowns, state, and bridges. Remove the settings that have no runtime reader.

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

Keep credentials in separate JSON secrets files with mode `0600`. Tool-client endpoints should stay on loopback or a trusted private network.

## Check the repository

```sh
npm run typecheck
npm test
npm run build
```
