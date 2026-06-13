# Configuration

All runtime configuration for niri lives in two TOML files passed on the
command line:

```
coral --config /path/to/config.toml --secrets /path/to/secrets.toml.env
```

Both flags are optional. When omitted, the values below fall back to their
defaults. Keys in the secrets file are deep-merged on top of the config file,
so a key declared in both resolves to the secrets value.

> **Why two files?** Secrets are kept out of the main config (and the process
> environment) so spawned subprocesses — including the agent's shell tool —
> never inherit credentials. `secrets.toml.env` should be permission-restricted
> and excluded from version control.

The systemd module (`flake.nix`) exposes matching options:

```nix
services.coral = {
  enable      = true;
  configFile  = "/etc/coral/config.toml";
  secretsFile = "/etc/coral/secrets.toml.env";
};
```

Both are nullable; when set, they're appended to the service's `ExecStart`.

---

## `[server]`

| Key | Default | Description |
|---|---|---|
| `port` | `3000` | HTTP port the server listens on. |

## `[agent]`

| Key | Default | Description |
|---|---|---|
| `name` | `"niri"` | Display name injected into the summarizer prompt and system grounding. |
| `env` | `"default"` | Runtime tag. Set to `"local"` to skip the primary model entirely and run on the fallback only. |

---

## `[model]` — primary

Used for normal agent turns.

| Key | Default | Description |
|---|---|---|
| `provider` | *(required)* | Provider name in the pi registry — e.g. `"openrouter"`, `"openai"`, `"deepseek"`. Resolves base URL and reasoning flags. Required unless `agent.env = "local"`. |
| `name` | *(required)* | Model id — e.g. `"deepseek/deepseek-r1"`, `"claude-sonnet-4-5"`. Required unless `agent.env = "local"`. |
| `base_url` | *(from registry)* | OpenAI-compatible base URL override for unlisted/self-hosted endpoints. |
| `tool_choice` | `"required"` | `"required"`, `"auto"`, or `"none"`. |
| `enable_thinking` | `true` | Extended reasoning on models that support it. |
| `thinking_effort` | `"low"` | Reasoning budget: `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`. |
| `api_key` *(secret)* | *(required)* | API key for the primary endpoint. Place this in `secrets.toml.env`. |

## `[fallback]`

Used when the primary endpoint is unreachable or `agent.env = "local"`.
Defaults target a small, cheap model suitable for local LM Studio / Ollama.

| Key | Default | Description |
|---|---|---|
| `provider` | *(inferred)* | Provider for the fallback model. Inferred from `base_url` if omitted (`localhost` → `lm-studio`). |
| `model` | `"zai-org/glm-4.7-flash"` | Fallback model id. |
| `base_url` | *(from registry)* | Base URL for the fallback model. |
| `tool_choice` | `"required"` | `"required"`, `"auto"`, or `"none"`. |
| `n_ctx` | `4096` | Declared context window size used for context-limit enforcement. |
| `context_margin` | `256` | Token headroom reserved before a soft nudge is issued. |
| `hard_overflow_tokens` | `1024` | Tokens above the window that trigger a hard prompt truncation. |
| `enforce_context_limit` | `true` if base URL is localhost | Whether to enforce the context window limit. |
| `referer` | — | `HTTP-Referer` header on fallback requests (OpenRouter attribution). |
| `title` | — | `X-Title` header on fallback requests. |
| `api_key` *(secret)* | — | API key override for the fallback endpoint. |

## `[summary]`

Optional dedicated summarizer model. Falls back to the primary if not configured.

| Key | Default | Description |
|---|---|---|
| `provider` | *(inferred)* | Provider for the summary model. |
| `model` | *(uses primary)* | Model id. Leave empty to reuse the primary. |
| `base_url` | *(from registry)* | Base URL override. |
| `referer` | — | `HTTP-Referer` header on summary requests. |
| `title` | — | `X-Title` header on summary requests. |
| `api_key` *(secret)* | — | API key override for the summary endpoint. |

---

## `[embeddings]`

Embeddings power semantic memory search. Set `api_key` to enable; without it
the embedding client is disabled and memory search falls back to keyword
matching.

| Key | Default | Description |
|---|---|---|
| `model` | `"google/gemini-embedding-2-preview"` | Embedding model id. |
| `dimensions` | `3072` | Output vector dimensions. Must match the database schema; changing it requires rebuilding `memory_chunk_vec`, `memory_prototype_vec`, and embedding meta. |
| `base_url` | `"https://openrouter.ai/api/v1"` | OpenAI-compatible base URL. |
| `referer` | — | `HTTP-Referer` header on embedding requests. |
| `title` | — | `X-Title` header on embedding requests. |
| `api_key` *(secret)* | — | API key for the embedding endpoint. |

---

## `[context]`

Token / compaction thresholds.

| Key | Default | Description |
|---|---|---|
| `token_nudge_threshold` | `120000` | Tokens at which the runner hints to the primary model to wrap up before compaction. |
| `fallback_token_nudge_threshold` | `50000` | Same nudge, but for the fallback model's smaller window. |
| `compact_target_tokens` | `65000` | Target post-compaction size. |
| `compact_trigger_tokens` | `90000` | Tokens that trigger automatic compaction. |
| `compact_recent_messages` | `80` | Recent messages retained verbatim during compaction. |
| `compact_chunk_messages` | `32` | Messages summarized per compaction chunk. |
| `compact_summary_max_chars` | `16000` | Hard cap on generated summary length. |
| `idle_compaction_minutes` | `45` | Idle time before background compaction runs. Decimals supported (e.g. `2.5` for 2m30s). Set to `0` to disable. |

## `[runner]`

| Key | Default | Description |
|---|---|---|
| `max_turns` | `120` | Hard cap on LLM turns per wakeup before the runner forces a rest. |
| `max_identical_tool_turns` | `10` | Maximum consecutive turns with the same tool-call signature before the runner bails to break a loop. |

---

## `[container]` and `[ssh]`

Three execution backends are available: local shell (default), Docker, and
SSH. The two override sections are mutually exclusive — setting fields in
both throws at startup.

### `[container]` (Docker)

| Key | Default | Description |
|---|---|---|
| `name` | — | Docker container name. **Both** `name` and `user` must be set to activate Docker mode. Commands run as `docker exec -i -u <user> -w <cwd> <name> bash -c <cmd>`. |
| `user` | — | Linux username inside the container. Must be set alongside `name`. |

The harness home (soul, memories, DB) is anchored to the repo-local `home/`
directory, which should be bind-mounted into the container.

### `[ssh]`

| Key | Default | Description |
|---|---|---|
| `target` | — | SSH destination in `user@host` form. Setting this activates SSH mode: shell commands run on the remote host via `ssh <target> bash -c <cmd>`. |
| `identity` | — | Path to the SSH private key passed as `ssh -i <path>`. Omit to use the agent's default key or `~/.ssh/config`. |

## `[image_tool]`

| Key | Default | Description |
|---|---|---|
| `max_bytes` | `150000` | Max image size in bytes accepted by `image_tool`. |
| `root` | `home/images` (local/SSH) or `/home/<user>/images` (Docker) | Absolute path bounding all `image_tool` operations. Must start with `/`. |

---

## `[discord]`

### Credentials & identity

| Key | Default | Description |
|---|---|---|
| `bot_token` *(secret)* | — | Discord bot token. **Required** for any Discord functionality. Without it the gateway and REST client are both disabled. |
| `bot_user_id` | *(auto-detected)* | Bot user id. Auto-populated from the gateway READY payload on first connect. |
| `scan_channel_ids` | `[]` | Channel ids the bot treats as its inbox. DMs are always included regardless. Example: `["1234567890", "0987654321"]`. |

### Gateway (WebSocket listener)

| Key | Default | Description |
|---|---|---|
| `gateway_enabled` | `true` | Disable the WebSocket gateway entirely. Useful when only REST polling is wanted. |
| `gateway_trace` | `false` | Verbose per-message trace logging (noisy; for debugging). |
| `gateway_raw_fallback` | `true` | Use the raw `MESSAGE_CREATE` packet handler as a DM fallback for messages discord.js doesn't surface. |
| `gateway_raw_fallback_all` | `false` | Extend the raw fallback to all channel types, not just DMs. |
| `wake_on_event` | `false` | Wake the runner on every ingested guild channel message (not just DMs). DMs always wake. |
| `wake_on_dm` | `true` | Wake immediately on DMs even when `wake_on_event` is false. |

### Batch digest (REST polling)

| Key | Default | Description |
|---|---|---|
| `batch_interval_ms` | `60000` | How often (ms) the server polls Discord for new messages. Minimum 1 000 ms. |
| `batch_max_messages` | `40` | Max messages fetched per channel per poll. Capped at 200. |
| `batch_scan` | `true` | Disable REST batch scanning while keeping the gateway running. |
| `batch_only_configured` | `true` | When `true`, batch digests only include DMs and channels in `scan_channel_ids`. |
| `pending_auto_seen_minutes` | `10` | Age in minutes after which a pending Discord item is demoted to "seen" without a response. |

### REST client

| Key | Default | Description |
|---|---|---|
| `rest_max_attempts` | `3` | Max retry attempts on transient REST failures (rate limits, 502/503/504). Capped at 10. |
| `rest_retry_base_ms` | `1000` | Base delay for exponential backoff. Min 100 ms, max 30 000 ms. |

---

## `[metrics]`

| Key | Default | Description |
|---|---|---|
| `retention_days` | `3` | Days to retain metrics rows before they are pruned. |
