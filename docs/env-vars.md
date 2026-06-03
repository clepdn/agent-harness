# Environment Variables

All configuration knobs for niri are set via environment variables. 

---

## Core

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port the server listens on. |
| `NIRI_ENV` | `default` | Runtime environment tag. Set to `local` to skip the primary model entirely and run on the fallback only (`USE_FALLBACK=true`). |
| `AGENT_NAME` | `niri` | Display name injected into the summarizer prompt and system grounding. |

---

## Primary Model

The primary model is used for all normal agent turns.

| Variable | Default | Description |
|---|---|---|
| `MODEL_PROVIDER` | *(required)* | Provider name as registered in the pi model registry — e.g. `openrouter`, `openai`, `deepseek`, `anthropic`. Used to resolve the base URL and expected API key env var automatically. Required unless `NIRI_ENV=local`. |
| `MODEL` | *(required)* | Model ID for the primary LLM — e.g. `deepseek/deepseek-r1`, `claude-sonnet-4-5`, `gpt-4o`. Required unless `NIRI_ENV=local`. |
| `MODEL_BASE_URL` | *(from registry)* | Override the OpenAI-compatible base URL for the primary model. Use this for unlisted or self-hosted endpoints. |
| `MODEL_API_KEY` | *(from provider env)* | Explicit API key for the primary model. Only needed when the provider's standard key variable (e.g. `OPENROUTER_API_KEY`, `OPENAI_API_KEY`) is not set or you want to override it. |

> **API key resolution order:** niri first checks `MODEL_API_KEY`, then falls back to the provider's standard key variable (`<PROVIDER>_API_KEY` in uppercase, e.g. `DEEPSEEK_API_KEY`).

---

## Fallback Model

The fallback model handles turns when the primary is unavailable or `NIRI_ENV=local`. It defaults to a small, cheap model suitable for local LM Studio / Ollama setups.

| Variable | Default | Description |
|---|---|---|
| `FALLBACK_PROVIDER` | *(inferred)* | Provider for the fallback model. Inferred from `FALLBACK_BASE_URL` if omitted (`localhost` → `lm-studio`). |
| `FALLBACK_MODEL` | `zai-org/glm-4.7-flash` | Model ID for the fallback LLM. |
| `FALLBACK_BASE_URL` | *(from registry)* | Base URL for the fallback model. Alias `FALLBACK_OPENAI_BASE_URL` is also accepted. |
| `FALLBACK_API_KEY` | *(from provider env)* | Explicit API key override for the fallback model. |
| `FALLBACK_N_CTX` | `4096` | Declared context window size (tokens) for the fallback model. Used when building the model descriptor and for context-limit enforcement. |
| `FALLBACK_CONTEXT_MARGIN` | `256` | Token headroom reserved at the top of the fallback context window before a soft nudge is issued. |
| `FALLBACK_HARD_OVERFLOW_TOKENS` | `1024` | Tokens above the context window size that trigger a hard truncation of the fallback prompt. |
| `FALLBACK_ENFORCE_CONTEXT_LIMIT` | `true` if base URL is localhost | Whether to enforce the context window limit for the fallback model. Auto-enabled for local endpoints. |
| `FALLBACK_OPENAI_REFERER` | — | Sets the `HTTP-Referer` header on fallback requests (used by some OpenRouter-style proxies for attribution). |
| `FALLBACK_OPENAI_TITLE` | — | Sets the `X-Title` header on fallback requests. |

---

## Summary Model

An optional, separate model used for conversation compaction / summarization. Falls back to the primary model if not configured.

| Variable | Default | Description |
|---|---|---|
| `SUMMARY_PROVIDER` | *(inferred)* | Provider for the summary model. |
| `SUMMARY_MODEL` | *(uses primary)* | Model ID for summarization. Leave unset to use the primary model. |
| `SUMMARY_BASE_URL` | *(from registry)* | Base URL override for the summary model. Alias `SUMMARY_OPENAI_BASE_URL` is also accepted. |
| `SUMMARY_API_KEY` | *(from provider env)* | Explicit API key override for the summary model. |
| `SUMMARY_OPENAI_REFERER` | — | Sets the `HTTP-Referer` header on summary requests. |
| `SUMMARY_OPENAI_TITLE` | — | Sets the `X-Title` header on summary requests. |

---

## Tool Choice

| Variable | Default | Description |
|---|---|---|
| `PRIMARY_TOOL_CHOICE` | `required` | Tool-call mode for the primary model: `required`, `auto`, or `none`. `TOOL_CHOICE` is accepted as a legacy alias. |
| `FALLBACK_TOOL_CHOICE` | `required` | Tool-call mode for the fallback model: `required`, `auto`, or `none`. |

---

## Thinking / Reasoning

| Variable | Default | Description |
|---|---|---|
| `ENABLE_THINKING` | `true` | Enable extended reasoning / thinking mode on models that support it. Accepts `true`/`false`/`1`/`0`/`yes`/`no`/`on`/`off`. |
| `THINKING_EFFORT` | `low` | Budget level for reasoning tokens. One of `minimal`, `low`, `medium`, `high`, `xhigh`. Higher values produce more thorough reasoning at greater cost. |

---

## Context / Token Management

| Variable | Default | Description |
|---|---|---|
| `TOKEN_NUDGE_THRESHOLD` | `120000` | Token count in the primary conversation at which the runner hints to the model to start wrapping up the current task before compaction. |
| `FALLBACK_TOKEN_NUDGE_THRESHOLD` | `50000` | Same nudge threshold, but for the fallback model's (smaller) context window. |
| `CONTEXT_COMPACT_TRIGGER_TOKENS` | `90000` | Token count that triggers automatic conversation compaction (summarization + history trim). |
| `IDLE_COMPACTION_MINUTES` | `45` | Minutes of idle time (while waiting for events) before triggering background compaction. When the agent calls `wait` and no event arrives within this timeout, the runner checks if context exceeds `CONTEXT_COMPACT_TRIGGER_TOKENS` and runs LLM summarization if needed. Supports decimals (e.g. `2.5` for 2m30s). Set to `0` or leave unset to disable. Alias: `IDLE_TIMEOUT`. |

---

## Runner Loop

| Variable | Default | Description |
|---|---|---|
| `RUNNER_MAX_TURNS` | `120` | Hard cap on the number of LLM turns (tool call → response cycles) per wakeup before the runner forces a rest. |
| `RUNNER_MAX_IDENTICAL_TOOL_TURNS` | `10` | Maximum consecutive turns that produce the exact same tool call signature before the runner bails out to break a potential loop. |

---

## Container / Shell

Three execution backends are available: local shell (default), Docker, and SSH. Docker and SSH are mutually exclusive — setting vars for both throws at startup.

### SSH

| Variable | Default | Description |
|---|---|---|
| `SSH_TARGET` | — | SSH destination in `user@host` form. Setting this activates SSH mode: all shell commands run on the remote host via `ssh <target> bash -c <cmd>`. The harness home (soul, memories, DB) stays local, anchored to the repo-local `home/` directory. |
| `SSH_IDENTITY` | — | Path to the SSH private key passed as `ssh -i <path>`. Optional — omit to use the agent's default key or `~/.ssh/config`. |

### Docker

| Variable | Default | Description |
|---|---|---|
| `NIRI_CONTAINER` | — | Docker container name. **Both** `NIRI_CONTAINER` and `NIRI_USER` must be set to activate Docker mode; setting only one has no effect. Commands run as `docker exec -i -u <NIRI_USER> -w <cwd> <NIRI_CONTAINER> bash -c <cmd>`. The harness home is anchored to the repo-local `home/` directory (which should be bind-mounted into the container). |
| `NIRI_USER` | — | Linux username inside the container. Must be set alongside `NIRI_CONTAINER`. |

### Shared

| Variable | Default | Description |
|---|---|---|
| `IMAGE_ROOT` | `home/images` (local/SSH) or `/home/<user>/images` (Docker) | Absolute path bounding all `image_tool` operations. Must start with `/`. |
| `IMAGE_TOOL_MAX_BYTES` | `150000` | Maximum image file size in bytes accepted by `image_tool`. |

---

## Embeddings

Embeddings power semantic memory search. Configure these to enable memory retrieval.

| Variable | Default | Description |
|---|---|---|
| `EMBEDDING_API_KEY` | — | API key for the embedding endpoint. **Required** to enable embeddings; without it the embedding client is disabled and memory search falls back to keyword matching. |
| `EMBEDDING_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible base URL for the embedding model. |
| `EMBEDDING_MODEL` | `google/gemini-embedding-2-preview` | Embedding model ID. |
| `EMBEDDING_DIMENSIONS` | *(from DB schema)* | Output dimension count for embedding vectors. Must match the dimension the database was initialized with. |
| `EMBEDDING_OPENAI_REFERER` | — | Sets the `HTTP-Referer` header on embedding requests. |
| `EMBEDDING_TITLE` | — | Sets the `X-Title` header on embedding requests. |

---

## Discord

### Credentials & Identity

| Variable | Default | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | — | Discord bot token. **Required** for any Discord functionality. Without it the gateway and REST client are both disabled. |
| `DISCORD_SCAN_CHANNEL_IDS` | — | Comma-separated list of guild channel IDs that the bot should treat as its inbox. DMs are always included regardless. |

### Gateway (WebSocket listener)

| Variable | Default | Description |
|---|---|---|
| `DISCORD_GATEWAY_ENABLED` | `true` | Set to `false` to disable the Discord WebSocket gateway entirely. Useful when you only want REST polling. |
| `DISCORD_GATEWAY_TRACE` | `false` | Enable verbose per-message trace logging for the gateway (noisy; for debugging only). |
| `DISCORD_GATEWAY_RAW_FALLBACK` | `true` | Use the raw `MESSAGE_CREATE` packet handler as a fallback for messages that discord.js does not surface via its `MessageCreate` event (commonly DMs in large bots). |
| `DISCORD_GATEWAY_RAW_FALLBACK_ALL` | `false` | Extend the raw fallback to all channel types, not just DMs. Enables the bot to pick up guild messages that discord.js drops before caching completes. |
| `DISCORD_WAKE_ON_EVENT` | `false` | Wake the runner immediately on every ingested guild channel message (not just DMs). DMs always wake the runner regardless of this flag. |

### Batch Digest (REST polling)

| Variable | Default | Description |
|---|---|---|
| `DISCORD_BATCH_INTERVAL_MS` | `60000` | How often (ms) the server polls Discord for new messages in configured channels. Minimum 1 000 ms. |
| `DISCORD_BATCH_MAX_MESSAGES` | `40` | Maximum number of messages fetched per channel per poll cycle. Capped at 200. |
| `DISCORD_BATCH_SCAN` | `true` | Set to `false` to disable REST batch scanning while keeping the gateway running. |
| `DISCORD_BATCH_ONLY_CONFIGURED` | `true` | When `true`, batch digests only include DMs and channels listed in `DISCORD_SCAN_CHANNEL_IDS`. Set to `false` to include all visible channels. |
| `DISCORD_PENDING_AUTO_SEEN_MINUTES` | `10` | Age in minutes after which a pending Discord item is automatically demoted to "seen" without the agent responding. |

### REST Client

| Variable | Default | Description |
|---|---|---|
| `DISCORD_REST_MAX_ATTEMPTS` | `3` | Maximum retry attempts for failed Discord REST calls (rate limits, 502/503/504). Capped at 10. |
| `DISCORD_REST_RETRY_BASE_MS` | `1000` | Base delay in milliseconds for exponential backoff on REST retries. Minimum 100 ms, maximum 30 000 ms. |

---

## Metrics

| Variable | Default | Description |
|---|---|---|
| `METRICS_RETENTION_DAYS` | `3` | Number of days to retain metrics rows before they are pruned. |
