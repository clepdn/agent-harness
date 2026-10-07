# Nano plugin architecture and migration plan

Base: upstream main `28562968c4350c4e9cecc175403c67820e4e3318`. Baseline `npm test`: 338 passing tests; `npm run typecheck`: passed. Fast mode status reports on; OpenAI priority is configured. Backend priority activation is not established by returned request metadata.

## Fixed core and kernel

Nano's existing conversation `Context` remains the immutable-message/cache-lineage core: append preserves lineage, edits/forks invalidate it, restoration preserves identity and effort timeline, completion commits atomically only if revision is unchanged. It is not Cordis's dependency-injection Context. Configuration loading, layering, validation and secret redaction remain core.

A small `@nano/plugins` kernel supplies `PluginScope`, typed service/event/extension-slot tokens, dependency scheduling, ownership, cancellation and inspectable lifecycle status. This mechanism is necessary to compose replaceable capabilities; it must contain no model, Discord, memory, runner, HTTP, UI or persistence implementation. Entrypoints select a composition, install plugins and handle OS shutdown. Business capabilities belong to plugins, including persistence and inference dispatch.

Services are direct typed in-process calls. Plugins declare required and optional dependencies, provide services, contribute keyed slots, register listeners and own resources through their scope. Required dependency disappearance unloads dependents before provider cleanup; reappearance activates them again. Duplicate service/slot providers fail visibly. Extension means declared contracts and slots, not monkey-patching another plugin. Configuration is validated before activation. Failed initialization rolls back all owned registrations. Callback/disposal failures are retained in status; unrelated plugins continue. Activation generations reject late registrations after cancellation. Cleanup is awaited in reverse ownership order. Explicit enable/disable/replace/retry and missing-dependency diagnostics form the management API.

## Cordis research and reuse decision

Actual DeepSeek Harness source examined at `5badb15009ae1756c3afe0ae0cef1faafc290ccc`, particularly `vendor/cordis/src/{fiber,reflect,events,service}.ts`, `packages/api/gateway`, `packages/typert/{protocol,generator}` and `packages/client/ui-slots`. Official lifecycle: https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/ . Source: https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc .

Cordis has scoped service injection, dependency epochs, pending/loading/active/failed/unloading/disposed states and owned effects. Disposers start in reverse order but async completion is concurrent. Its ordinary event `emit` directly invokes callbacks and ignores returned promises; lifecycle containment does not make ordinary callbacks safe. It supplies neither Nano's trust boundary nor a general plugin AbortSignal.

Direct reuse is viable behind a safety adapter, but would require substantial adapter behavior and preserving two Context concepts. Selected implementation: a small local typed runtime with explicit serial cleanup and cancellation, following Cordis lifecycle rather than copying Harness application code. Maintenance cost is local scheduler tests; benefit is one inspectable contract without alpha coupling or unchecked event dispatch. Upstream Cordis is MIT, source version `4.0.5-alpha.1`, npm latest `4.0.4`; MIT reuse requires retaining notices. No upstream code is vendored. Gateway release/source license metadata differ across versions, another reason not to import it blindly.

DeepSeek's generated descriptors share runtime codecs and client method contracts; its client slots separate browser composition from rendering. Nano uses a shared typed method/stream descriptor library and inferred client bindings rather than duplicating server/client types. It does not need Harness's entire Typert generator.

## Fault and trust boundaries

Trusted plugins run in-process. The runtime contains ordinary thrown/rejected initialization, owned callbacks, operation calls and cleanup failures. It cannot contain `process.exit`, synchronous infinite loops, OOM, native crashes or malicious code. Timeouts/cancellation are cooperative, not preemption. Untrusted executable plugins require separate OS processes with restricted credentials/filesystem/network and typed RPC capability grants; importing them in-process is not a sandbox. The initial supported API is explicitly trusted in-process composition, with replaceable external carriers and existing supervised workers as process boundaries. No universal crash-containment claim is made. An untrusted-plugin process runner is a distinct security product, not a catch-wrapper promise.

## Public operations and external transport

Only explicitly registered exports are remotely callable. Shared descriptors define input/output validation, method kind, permission, stable errors and cancellation. HTTP carries unary browser calls; WebSocket multiplexes stream subscriptions and cancellations. Authentication/authorization, bounded frames and runtime validation live at the gateway. Local integrations invoke the same operation handlers directly, without HTTP or serialization. Core and business services do not import transports.

Method results and history/event streams are distinct. Durable worker history uses monotonically increasing sequence cursors, replay-before-live, deduplication and explicit replay-gap/reconnect semantics. Volatile text/thinking deltas cannot promise durable replay. Existing HTTP routes, SSE framing, scoped/unscoped chat URLs and tool executor NDJSON remain compatibility carriers for the same operation contracts, not separate business implementations. Local unauthenticated compatibility behavior remains explicit; token-authenticated mode fails closed and authorization is per export.

The web application is a plugin client. Typed UI slots contribute panels, renderers and actions. HTTP hosting, RPC gateway, SSE/WebSocket carriers, browser rendering and client connection are separate plugins. Existing terminal clients use shared application contracts. No new native desktop or terminal application is required.

## Capability-to-plugin inventory

| Current capability and source | Plugin ownership / compatibility |
| --- | --- |
| `llm.ts` Context lineage, immutable items, effort timeline | fixed conversation core; provider wire code removed to provider plugin |
| `config.ts`, `@nano/config`, agent config | fixed config core; existing layered JSON and defaults retained, plugin selection added |
| OpenAI-compatible completion, stream/cache warming, bridge metadata, fast tier | model-provider plugins; public provider slot, no default hidden provider in core |
| runner/model-state, loop, frontend, fallback/swap/recovery | runner/model-operation plugins using provider service; both lanes retained |
| session snapshots, backups, handoffs, discard/quarantine, context-store/LCM | session/history and context-management plugins; filenames/schema unchanged |
| compaction companion/context-full/snapcompact/remote/off, cache warmer, image hydration | strategy/image plugins using declared slots/services; existing selection and cache behavior retained |
| nano.db conversation/Discord/memory/context tables, metrics.db, state revisions | persistence/metrics plugins; existing migrations and durable formats retained |
| memory filesystem/search/aliases/embeddings/skills, frontend virtual soul | memory plugin; temporary stores for verification, no production migration |
| Discord gateway/REST/ingress/inbox/history/search/send/upload/status/typing/voice/avatar/emoji | Discord plugin services and tool/command contributions; absence does not disable runner/provider/memory |
| Discord slash commands fast/status/trace/restart/compact/join/leave/voice/interrupt/discard/model | command plugin contributions, Discord adapter only renders/interacts; same application operations |
| client local NodeToolHost/remote switch, six executor capabilities | tool-executor/client plugin; existing harness wire format and workspace semantics retained |
| tool catalogs and loop handler table | owned public tool slot; families register definitions and execution together |
| shell jobs, subagents, web search, remote image tools | independent jobs/subagent/search/image plugins |
| wait/rest/wait_then_continue, session controls, context grep/expand | runner/context tool plugins, owned removal on unload |
| agent-channel durable mailbox, job completion, boredom timers, cron/chat/webhook/bsky triggers | wake/event transport plugins using shared runner operations |
| worker outbox, volatile stream buffer, replay/pruning | event/history plugin services; seq-zero live events remain distinguishable |
| worker Fastify routes /awp,/trigger,/chat,/status,/metrics,/discord,/client | HTTP host and compatibility gateway plugins over shared operations |
| outer control DB, discovery/supervisors, mirrored events, agent proxy/compaction views | control persistence/supervisor/operations plugins; existing multi-agent URLs preserved |
| Prometheus exporter, metric recording | observability plugin, independent of Discord gateway |
| static /ui hosting and Vite development carrier | UI hosting plugin, browser client is not kernel |
| web panels/status/history/chat/Discord/compactions | client application plugins and typed UI contribution slots |
| TUI, scripts/chat, standalone executor | client applications using same bindings and owned lifecycle; existing supported interfaces retained |
| shim bootstrap, OS signals/restart launcher | bootstrap/lifecycle plugin; only process admission/termination glue at entrypoint |

## Migration sequence and acceptance

1. Commit this plan before source migration. Implement generic public kernel, lifecycle and contract tokens.
2. Migrate provider and conversation dispatch, runtime services/tools/strategies, startup and control compositions in bounded ownership slices. Built-ins must use exactly the third-party public contracts. Remove obsolete hardcoded registration paths.
3. Add explicit shared operation descriptors, gateway/HTTP/WebSocket plugins and compatibility adapters; migrate client calls and typed UI slots.
4. Verify third-party provider + command from public imports only; failed apply/callback/disposal; disable/replace/recover memory/Discord/provider independently; dependency disappearance and listener/tool/command cleanup; config validation; durable session/history restart. Use local fakes and temporary stores only.
5. Run full relevant suites, typecheck, actual local server/client smoke and UI confirmation, `git diff --check`. Document exact APIs, errors, ordering, replay and migration. Commit coherent slices, record base/final hashes and create source-only patch/archive under `/data`. No pushes/deployments/Discord sends/paid inference/private-state inspection.
