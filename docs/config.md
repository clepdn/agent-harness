# Configuration

Nix is the source configuration format. The NixOS module in `flake.nix` turns
attribute sets directly into JSON with `pkgs.formats.json`; workers and the
control plane read the generated JSON. No TOML parser or conversion step is used.

```nix
services.nano = {
  enable = true;
  settings = {
    server = { port = 3000; listen = "127.0.0.1"; };
    models.primary = {
      provider = "openai";
      model = "your-model-id";
      cache_lifetime_minutes = 30;
      respect_prompt_cache = true;
    };
    model.preset = "primary";
  };
  agents.nano = { client = "local"; };
  secretsFile = "/run/agenix/nanoSecrets"; # decrypted contents must be JSON
};
```

Use `services.nano.settings = import ./config.nix;` to keep settings in a separate
Nix file; [config.example.nix](../config.example.nix) provides a starting point.
`services.nano.agents` generates one `.json` file per agent. Leaving `agents`
empty runs a standalone worker. `configFile` can point at an existing JSON file
to bypass generation from `settings`.

For a source checkout, generate the runtime file directly:

```sh
nix eval --json --file config.nix > config.json
npm run start:worker -- --config config.json --secrets /path/to/secrets.json
```

Both CLI flags are optional. Defaults apply when omitted. Repeat `--config` to
layer files: objects merge recursively, arrays and other values replace previous
values, and secrets merge last. Named model presets resolve after merging, so
credentials can live under matching `models.<name>` objects in the secrets file.
JSON keys containing dots remain literal keys; use nested objects for sections.

The control plane also accepts `--config`; it reads `server` settings for the Web
UI bind address and port. Explicit `--host` and `--port` flags win.

Keep secrets out of Nix attribute sets and the Nix store. Use a permission-restricted
JSON secrets file (see [secrets.example.json](../secrets.example.json)), or an
extensionless decrypted secret with JSON contents. Credentials are read from
files rather than the process environment, so tool subprocesses do not inherit
them. Do not commit secrets.

The runtime and control plane read JSON configuration. Existing TOML files,
agent files, or secret files must be converted to JSON before deployment. The
NixOS module emits JSON directly and does not convert external files or encrypted
secrets. The optional development shim reads `~/.harness.json`, with a nested
`shim` object containing `enable`, `harness_path`, and optional `config_path`.

---

## `server`

| Key | Default | Description |
|---|---|---|
| `port` | `3000` | HTTP port the server listens on. |
| `listen` | `"127.0.0.1"` | Address the HTTP server and web UI bind to. Use `"0.0.0.0"` for all IPv4 interfaces. |

## `plugins`

`plugins` is a JSON object keyed by public plugin id. Each selected entry accepts
only `enabled` (boolean, default `true`) and `config` (a value passed to the
installed plugin's validator). Invalid ids, selection shapes, or fields are
rejected by runtime configuration validation. The setting selects statically
installed plugins; it does not import code named by JSON. See the [implemented
plugin API and inventory](plugin-architecture.md).

For worker applications, omitted selections keep each built-in enabled. Unknown
plugin ids are allowed by config validation, but only have an effect when that id
is part of the application composition. For example, the worker supports:

```json
{
  "plugins": {
    "nano.discord": { "enabled": false },
    "nano.web-search": { "enabled": true, "config": { "apiKey": "..." } },
    "nano.rpc-auth": {
      "config": { "mode": "token", "token": "...", "permissions": ["worker.read", "conversation.read"], "allowedOrigins": ["https://console.example"] }
    }
  }
}
```

`nano.rpc-auth` is shared by the worker and control application and accepts
`mode: "local-open"` or `"token"`. Token mode requires a non-empty `token`;
`permissions` and `allowedOrigins`, when specified, must be arrays of non-empty
strings. In token mode each RPC descriptor's permission must be listed or the
wildcard `"*"` granted. Local-open mode is intended for local callers and does
not use the permissions list as an access-control list. Requests with an Origin
must match an allowed origin, except the loopback local-open case. Missing RPC
auth selection keeps the explicit local-open compatibility default.

Worker plugin selection follows dependency declarations. Disabling a plugin
withdraws its service and registrations, closes owned resources, and unloads
required consumers first; consumers remain pending until a required service
returns. Durable stores are not deleted. A capability is not independently
disableable when a required application service depends on it. In the control
application, required built-ins (RPC auth, persistence, discovery, supervisor,
operations, and HTTP) cannot be disabled; `control.static-ui` is optional.

## `agent`

| Key | Default | Description |
|---|---|---|
| `name` | `"nano"` | Display name injected into the summarizer prompt and system grounding. |
| `env` | `"default"` | Runtime tag. Set to `"local"` to skip the primary model entirely and run on the fallback only. |

---

## `frontend`

Enables a second virtual nano inside the same worker. Owner-authored DMs route
to the main runtime; all other Discord ingress that would normally wake nano
routes to the frontend runtime. The frontend sees the main soul through a private
patch: its `memory://soul.md` edits never change the main `soul.md`. The two runtimes
share authored memories and Discord storage, but keep independent conversation loops, resumable session
files, rest snapshots, and context archives. They can exchange durable messages
with `agent_send` and inspect that mailbox with `agent_channel`.

The patch and virtual view live under `<home>/.nano/frontend-soul/`. At worker
startup, Git's three-way merge rebases frontend changes onto the current main
soul. A failed merge puts standard diff3 conflict markers in the frontend's
virtual `memory://soul.md`, clears its stale session, and wakes it to reconcile.

The frontend has the normal server-side tools, except that executor-backed
tools, executor job output, subagents, client uploads, and skills are unavailable.
Its Discord reads/searches also exclude the owner's DM channel.

| Key | Default | Description |
|---|---|---|
| `enable` | `false` | Start the virtual frontend runtime and enable Discord routing. |
| `preset` | *(undefined)* | Optional named model preset. When the key is omitted, the frontend follows the main runtime's currently active model, including live swaps. A defined empty string or unknown preset is invalid. |

---

## Runtime model swaps

The Discord owner can use `/model swap preset:<name>` to perform an immediate
fresh-session transition. The `POST /awp/swap-model` endpoint accepts
`{ "preset": "<name>" }` and runs the same lifecycle; it waits for completion
and returns `{ ok, action: "swapped", preset, model, provider, graceful }`, with
`fallbackReason` when the handoff had to archive rather than journal/end. A successful
response means the outgoing session closed, the selection was persisted/applied, and
a fresh bootstrap was scheduled; it does not wait for the new provider's first request.
The reported model/provider describe the runtime selection, not verified remote
backend identity. Missing/invalid presets return 400, an overlapping swap returns
409, and a lifecycle failure returns 503 with an `error` message.

The selected preset is validated before lifecycle changes. Outgoing lanes retain
their current model settings through handoff. The runner issues an
explicit journal-now instruction, then asks it to call `end_session`; a graceful
result requires a successful `edit_file` write to a file under `memory://journal/`
before that tool completes.
External events arriving during the transition are held in order outside the
outgoing context, then replayed as work for the new bootstrap.
That queue and handoff marker are persisted before the swap and cleared only after
replay succeeds, preserving pending work across restart. The selected preset is
persisted before new-context bootstrap as a preset name only; restart resolves that
name against current merged config and uses configured per-preset values, not mutable
settings inherited from an earlier runtime swap. If that preset no longer resolves,
startup fails explicitly rather than restoring the prior model selection. It does not
rewrite config or credentials.

The runner waits up to 15 seconds for an active turn to reach a safe boundary. If a
mutating tool or compaction remains active, the swap fails closed and leaves the old
selection in place. Background jobs or tools must actually unwind; cancelling a
synthetic job does not make a still-running mutation safe to overlap. Active inference
can be cancelled, with up to 5 seconds to settle. The graceful journal/end phase
allows at most eight turns or 90 seconds. If generation fails, the end is not reached,
a journal write is unconfirmed, or a wait blocks, the runner reports a non-graceful
result, records raw messages in the existing rest-context
provenance forest, saves its rest snapshot, clears session checkpoints, and supplies
the archived state to the fresh bootstrap. Swap end skips shutdown compaction and its
secondary summary request. The overall handoff is bounded to about 110 seconds
plus persistence, including any inherited frontend lane.

When the frontend inherits the main preset (omit `frontend.preset`), its lane is
held with the main lane and both must reach the safe close/archive barrier before
the global selection is installed. This remains within the overall ~110-second
handoff bound, plus persistence. An explicit frontend preset is unaffected.
`/model info`, `/model presets`, and `/fast` do not trigger session swaps.



---

## `model` — primary

Used for normal agent turns.

| Key | Default | Description |
|---|---|---|
| `provider` | *(required)* | Provider name in the pi registry — e.g. `"openrouter"`, `"openai"`, `"deepseek"`. Resolves base URL and reasoning flags. Required unless `agent.env = "local"`. |
| `name` | *(required)* | Model id — e.g. `"deepseek/deepseek-r1"`, `"claude-sonnet-4-5"`. Required unless `agent.env = "local"`. |
| `base_url` | *(from registry)* | OpenAI-compatible base URL override for unlisted/self-hosted endpoints. |
| `tool_choice` | `"required"` | `"required"`, `"auto"`, or `"none"`. |
| `fast` | `false` | Use OpenAI's priority service tier for GPT/Codex models. May also be set on a named model preset. |
| `enable_thinking` | `true` | Extended reasoning on models that support it. |
| `thinking_effort` | `"low"` | Initial reasoning budget: `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`. Model support varies. |
| `cache_warming` | `false` | Keep the primary session's prompt cache warm while waiting. Also supported on named presets and follows live model swaps. |
| `cache_warming_minutes` | `0` | Quiet-time budget before compaction, rounded up to the next cache-refresh boundary. `0` keeps warming indefinitely. Requires warming enabled and compaction strategy other than `"off"`. Owns idle compaction timing while warming is enabled. |
| `cache_warming_mode` | `"completion"` | `"completion"` replays with a one-token output cap, requiring an endpoint that honors it. `"prewarm"` uses llm-bridge's `prompt_cache_options.prewarm` extension for upstream Codex Responses; requires bridge forwarding and backend support. |
| `cache_lifetime_minutes` | `30` | Assumed provider cache lifetime. Refresh or idle compaction runs three minutes early (27 minutes for a 30-minute lifetime). Values at or below `3` disable both timers. This does not change the provider's retention policy. |
| `respect_prompt_cache` | `true` | Preserve the prompt prefix. When warming is disabled, compact after `cache_lifetime_minutes - 3` quiet minutes. Accepts the legacy `preserve_prompt_cache` name. |
| `api_key` *(secret)* | *(required)* | API key for the primary endpoint. Place this in `secrets.json`. |

### Dynamic effort on `Context`

For presets with `bridge = true`, or endpoints matching `llm_bridge_url`, startup
loads the bridge's authenticated `/v1/models` catalog. `Context.availableEfforts`
contains that model's advertised efforts; `Context.effortChangeMode` identifies
append-only updates (`"configuration-update"`) or a required cache reset
(`"cache-reset"`). Missing metadata disables dynamic control without changing
the configured initial effort or preventing normal inference.

```typescript
// GPT-6 Codex models: preserve the initial request-level effort and prefix.
context = context.changeEffort("high")
context.append({ role: "user", content: "Analyze the harder case", timestamp: Date.now() })
await context.complete()

// GPT-5.6 and other models: explicitly accept a new cache lineage.
context = context.changeEffort("high", { allowCacheReset: true })
```

Always keep the returned Context: cache-reset changes return a fork. GPT-6
changes return the same Context and append a configuration update before the
next user message. Add that message before completing or making another change;
adjacent updates are rejected. Session checkpoints retain the original effort
and update timeline. Local compaction starts a new lineage using the active
effort; prefix truncation restores the effort at the retained history boundary.

Deploy the matching llm-bridge update with Coral: Chat Completions must preserve
raw `configuration_update` items as ordered Responses input. Only GPT-6 Codex
models use this path. Automatic bridge compaction/truncation must not rewrite
update-bearing history; use Coral's explicit local compaction or a fresh context.
Direct inference remains supported, but does not expose this dynamic API.


Cache warming replays the last successful request's full messages, tools, and
reasoning settings through the same Chat Completions endpoint with
`max_completion_tokens = 1` in completion mode. In prewarm mode it instead sends
`prompt_cache_options = { prewarm = true, ttl = "30m" }`, which llm-bridge forwards
to Responses without generating output on a supporting backend. It adds no
messages, executes no tools, and does not
wake the agent. Real model requests postpone refreshes; busy turns, fallback use,
rest, and shutdown skip them. Each runner (including the frontend) warms its own
session. Refresh usage is recorded in usage metrics and logs. Requests still
incur input charges, and cache hits are subject to provider routing and availability.
Codex's bridge path strips output caps, so use `cache_warming_mode = "prewarm"`
there. Prewarm errors are logged and never fall back to ordinary generation.
With warming enabled, the warming budget replaces the ordinary idle timeout.
An unlimited budget (`cache_warming_minutes = 0`) disables idle compaction.
Public API documentation describes
prewarming for GPT-5.6 and later; the subscription Codex backend's acceptance
still needs live verification after deploying the bridge and runtime together.

For example, `cache_lifetime_minutes = 30` refreshes every 27 minutes.
With `cache_warming_minutes = 315`, Coral warms at 27, 54, …, 297 minutes,
then compacts at 324 minutes instead of warming again. The calculation is
`ceil(315 / 27) × 27 = 324`. A real model request resets this quiet-time budget;
warming does not. After compaction the next model request starts a fresh budget.
If compaction fails or cannot shrink the context, warming stops and compaction
retries after another refresh interval. Normal token-triggered and manual
compaction can still happen sooner.

Without warming, `respect_prompt_cache = true` and `cache_lifetime_minutes = 30`
give a 27-minute idle compaction timeout. Set cache respect to `false` or the
lifetime to `0` to disable this automatic idle pass. Token-triggered and manual
compaction are separate. All cache timing settings apply to the selected preset,
including independent frontend presets and model swaps.

`idle_compaction_minutes = X` is now a legacy alias for
`cache_lifetime_minutes = X` with cache respect enabled. This intentionally changes
the idle timeout from `X` to `X - 3` minutes. The new key wins in JSON when both
are supplied. The Nix module renames this option under `services.nano.settings.model`
and each `services.nano.settings.models.<name>` preset, defaults cache respect to
`true` for migrated definitions, and emits only the new keys in generated JSON.

## `fallback`

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

## `summary`

Optional dedicated summarizer model. Falls back to the primary if not configured
for automatic uses. Discord `/compact force:true` requires this model, uses it
even when prompt-cache preservation is enabled, and asks it for a detailed
play-by-play (work, successful and failed techniques, people, highlights, and
open loops). The result is dated through the newest summarized message and put
at the end of the next primary-model prompt with a one-time instruction to
journal it immediately. `/compact snapcompact:true` additionally requests a
bitmap archive of the discarded span, falling back to a text appendix.

| Key | Default | Description |
|---|---|---|
| `provider` | *(inferred)* | Provider for the summary model. |
| `model` | *(uses primary)* | Model id. Leave empty to reuse the primary. |
| `base_url` | *(from registry)* | Base URL override. |
| `referer` | — | `HTTP-Referer` header on summary requests. |
| `title` | — | `X-Title` header on summary requests. |
| `api_key` *(secret)* | — | API key override for the summary endpoint. |

---

## `embeddings`

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

## `context`

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
| `preserve_prompt_cache` | `true` | Keep the conversation prefix stable for prompt caching. Disables LLM compaction; model swaps always use a fresh-session handoff. |
| `tool_result_compaction_min_age_turns` | `5` | Minimum later assistant turns before a tool result is eligible for proactive compaction. |
| `tool_result_compaction_min_chars` | `2000` | Minimum tool-result length eligible for proactive compaction. |
| `tool_result_compaction_min_context_percent` | `50` | Minimum percentage of the active generation model's context window that must be used before proactive tool-result compaction runs. |

## `runner`

| Key | Default | Description |
|---|---|---|
| `max_turns` | `120` | Hard cap on LLM turns per wakeup before the runner forces a rest. |
| `max_identical_tool_turns` | `10` | Maximum consecutive turns with the same tool-call signature before the runner bails to break a loop. |

---

## `container` and `ssh`

Three execution backends are available: local shell (default), Docker, and
SSH. The two override sections are mutually exclusive — setting fields in
both throws at startup.

### `container` (Docker)

| Key | Default | Description |
|---|---|---|
| `name` | — | Docker container name. **Both** `name` and `user` must be set to activate Docker mode. Commands run as `docker exec -i -u <user> -w <cwd> <name> bash -c <cmd>`. |
| `user` | — | Linux username inside the container. Must be set alongside `name`. |

The harness home (soul, memories, DB) is anchored to the repo-local `home/`
directory, which should be bind-mounted into the container.

### `ssh`

| Key | Default | Description |
|---|---|---|
| `target` | — | SSH destination in `user@host` form. Setting this activates SSH mode: shell commands run on the remote host via `ssh <target> bash -c <cmd>`. |
| `identity` | — | Path to the SSH private key passed as `ssh -i <path>`. Omit to use the agent's default key or `~/.ssh/config`. |

## `image_tool`

| Key | Default | Description |
|---|---|---|
| `max_bytes` | `150000` | Max image size in bytes accepted by `image_tool`, including downloaded URL images. |
| `root` | `home/images` (local/SSH) or `/home/<user>/images` (Docker) | Absolute path bounding local-file `image_tool` operations. Must start with `/`. |

`image_tool.path` accepts either a local client image path or a public HTTP(S) image URL. URL images are fetched by the worker with the same byte limit; redirects are revalidated, and loopback, private-network, link-local, and nonstandard-port destinations are rejected. The frontend runtime exposes the URL form when its selected model supports vision, without requiring an attached client executor.

---

## `context_images`

| Key | Default | Description |
|---|---|---|
| `markdown` | `true` | Attach local Markdown images from loaded soul/core files, journal and memory reads/search/recall, and loaded skills when the model supports vision. |
| `max_bytes` | `5000000` | Maximum bytes per local image. Supports PNG, JPEG, GIF, and WebP. |
| `max_per_message` | `8` | Maximum image references loaded per context message, including Discord avatars and emoji. Clamped to 1–32. |

Use standard Markdown such as `![portrait](../images/portrait.png)`. Relative paths resolve from the Markdown file's directory; `memory://images/portrait.png` resolves under the agent's memories directory. Absolute paths are also accepted within the agent home. Symlinks must resolve inside that home. Remote URLs are not fetched. Inline and reference-style images work; code examples are ignored. Missing, invalid, or oversized images produce a short note without failing the model request.

The harness explains this capability when it assembles each fresh context. It does not modify `soul.md`. Image bytes are retained in saved context so resumed sessions keep their pictures.

---

## `discord`

### Credentials & identity

| Key | Default | Description |
|---|---|---|
| `bot_token` *(secret)* | — | Discord bot token. **Required** for any Discord functionality. Without it the gateway and REST client are both disabled. |
| `bot_user_id` | *(auto-detected)* | Bot user id. Auto-populated from the gateway READY payload on first connect. |
| `owner_id` | `""` | Discord user id allowed to use runtime control commands. The owner also receives deduplicated model API error DMs and can permanently mute one error fingerprint from its message button. |
| `attach_emoji_bitmap` | `true` | Attach custom Discord emoji as bitmap images when they enter vision context. Animated emoji are fetched as PNG, so only the first frame is included. |
| `include_user_avatars` | `false` | Attach an author's Discord avatar the first time their message enters vision context, including wake events, inbox, backread, and search results. Deduplicated while their avatar remains in context; the bot uses the separate option below. |
| `include_bot_avatar` | `false` | Attach the bot user's Discord avatar on each fresh context. Resuming a saved context retains the existing image. |
| `scan_channel_ids` | `[]` | Channel ids the bot treats as its inbox. DMs are always included regardless. Example: `[ "1234567890" "0987654321" ]` in Nix. |
| `owner_id` | — | Discord user id allowed to use slash commands and whose audio is relayed during realtime voice calls. |

### Gateway (WebSocket listener)

| Key | Default | Description |
|---|---|---|
| `gateway_enabled` | `true` | Disable the WebSocket gateway entirely. Useful when only REST polling is wanted. |
| `typing_enabled` | `true` | Send and refresh Discord's typing indicator while generating a response. Set to `false` to suppress outbound typing indicators without disabling the gateway. |
| `gateway_trace` | `false` | Verbose per-message trace logging (noisy; for debugging). |
| `gateway_raw_fallback` | `true` | Use the raw `MESSAGE_CREATE` packet handler as a DM fallback for messages discord.js doesn't surface. |
| `gateway_raw_fallback_all` | `false` | Extend the raw fallback to all channel types, not just DMs. |
| `wake_on_reaction` | `true` | Wake the bot when a non-bot user adds a reaction in a DM or configured guild channel. The event targets the reacted-to message; custom reaction emoji use the normal bitmap attachment path. Guild-channel cooldowns still apply. |
| `wake_on_event` | `false` | Wake the runner on every ingested guild channel message (not just DMs). DMs always wake. |
| `wake_on_dm` | `true` | Wake immediately on DMs even when `wake_on_event` is false. |
| `dm_wake_debounce_ms` | `5000` | Trailing-edge hold (ms) for a new DM wake; each matching author/channel message or typing event resets the hold. Messages accumulated during the hold are delivered together in order. `0` disables it. Successful manual/idle compaction immediately reactivates the runner for the next model turn; shutdown compaction does not. |
| `dm_wake_debounce_cap_ms` | `60000` | Maximum total DM wake hold (ms) from the first matching author/channel message, even while typing continues. |

### Realtime voice

| Key | Default | Description |
|---|---|---|
| `voice_enabled` | `false` | Enable owner-only `/join`, `/leave`, and `/voice` commands. `/join` enters the owner's current voice channel; V3 requests can delegate tool-capable work to the normal text runner. The bot auto-leaves when the owner moves/leaves or no humans remain. Requires the gateway, `owner_id`, `llm_bridge_url`, and `llm_bridge_api_key`. |
| `voice_model` | `gpt-live-1-codex` | Model sent to the bridge's `/v1/realtime/calls` route. |
| `voice` | `juniper` | Codex realtime output voice, selectable at runtime with `/voice`. Supported values include `juniper`, `maple`, `spruce`, `ember`, `vale`, `breeze`, `arbor`, `sol`, and `cove`. |

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

## `metrics`

| Key | Default | Description |
|---|---|---|
| `retention_days` | `3` | Days to retain metrics rows before they are pruned. |
