# Nano plugin architecture

Nano uses the published MIT `@deepseek-ai/cordis@4.0.4` runtime. Cordis owns plugin activation, dependencies, services, events, fibers, and effects. Nano does not implement another lifecycle engine or a plugin-manager compatibility facade.

Plugins are trusted in-process code. JSON configuration selects statically supplied code; it never imports a module named in JSON. This is not a sandbox or DeepSeek Harness service compatibility layer.

## Public packages

- `@nano/plugins`: real Cordis `CordisContext`, `Plugin`, `Fiber`, and `Service`, typed service/slot/event names, `configSchema`, and the ordinary `Contributions` service.
- `@nano/runtime-api`: runtime contracts, `nano` tokens, tool/command registration, fixed conversation/model-dispatch core, and genuinely shared infrastructure. `@nano/runtime-api/contracts/*` contains type-only feature contracts. `@nano/runtime-api/model` exports the immutable conversation `Context`, model contracts, `modelProviders`, and `registerModelProvider`, not provider implementations.
- `@nano/control-api`: control contracts, typed service tokens, and public Cordis/helper exports. Agent discovery/configuration behavior belongs to `@nano/plugin-control-discovery`; worker environment construction belongs to `@nano/plugin-control-supervisor`.
- `@nano/web-api`: UI contracts, four slot tokens, registration helpers, and public Cordis/helper exports. `createWebUI` and React slot rendering belong to `@nano/plugin-web-observer`.
- `@nano/protocol` and `@nano/protocol/rpc`: shared operation/stream descriptors, validators, auth contracts, and RPC registration.

Built-ins are 37 independent `@nano/plugin-<name>` packages under `packages/plugins/<name>`: 25 runtime, 7 control, 2 web, and 3 executor/TUI packages. They import only public package exports and use the same native `ctx.plugin()` composition path as third-party plugins. There are no private host imports or cross-package `src` imports.

Plugin packages and the three feature SDKs ship TypeScript/TSX source. Node consumers need a loader such as `tsx`; browser consumers need a TypeScript-capable bundler such as Vite. Source-required declaration dependencies ship as production dependencies. `@nano/plugins` and the protocol/harness support packages expose their built outputs.

Hosts depend on exact Cordis version `4.0.4`; SDKs and plugins declare that version as a peer, rather than bundling another runtime. The packed-package checks compare the actual Cordis constructor identity, not merely `Context.is()`'s cross-copy global brand. Always import declared package exports, not private implementation paths.

## Implementation ownership

Each built-in package owns its feature implementation and corresponding tests, not just a lifecycle adapter to an SDK factory. Public owner subpaths expose behavior needed by other plugins; obsolete SDK feature paths are not compatibility aliases.

| Owner packages | Implementation |
|---|---|
| `runner`, `agent-channel`, `jobs-service`, `subagents` | Conversation/frontend execution, triggers, mailbox, jobs, and subagent execution. |
| `persistence`, `model`, `client` | SQLite/schema/history/outbox/session/context storage; model state/OpenAI-compatible provider; configured/switchable executor client. |
| `discord`, `memory`, `embeddings` | Discord gateway/REST/state/commands/voice; memory indexing/search/sync/state tools; embeddings and provider headers. |
| `bootstrap`, `images`, `context-management` | Bootstrap/soul; image preparation/fetching; summarization/deep archive and canonical conversation-message helpers. |
| `tools`, `tool-families`, `web-search` | Catalog/filter/reconciliation; command/file/git behavior; search provider behavior. |
| `events`, `metrics`, `observability`, `http` | Event stream; metric store/registry; Prometheus HTTP exporter; worker HTTP carrier. |
| `control-discovery`, `control-supervisor`, `web-observer` | Agent loading/resolution/configuration; worker environment/supervision; UI notifications/actions/React rendering. |

The remaining runtime SDK contains immutable conversation `Context`, model/provider contracts and dispatch, stream/message types, configuration/identity, typed registration, and shared helpers: durable file writes (bootstrap/memory/model/persistence), cache policy (configuration/model/runner), RPC gateway (worker/control HTTP), whitespace normalization (memory/Discord), media validation (images/Discord), and shared memory schema constants. Error classification belongs to `runner`; OpenAI header construction belongs to `embeddings`. Host-only shim code remains in `@nano/runtime`, and multi-plugin fixtures remain under `tests/support`, not in shipped APIs.

`tests/plugin-ownership.test.ts` restricts runtime SDK modules/value exports and requires feature contracts to erase at runtime. Together with the public-boundary regression and packed consumption smoke, it rejects the former runtime-SDK wrapper-only layout and preserves the public consumption boundary. Feature ownership is also reviewed across all built-ins; a renamed shared implementation catch-all is not an acceptable replacement.

## Native plugins and services

`Plugin` is Cordis's function/class/object union. Use `Plugin.Object<C>` to type object plugins precisely. Native metadata is `name`, required `inject` service names, optional `provide` metadata, and Standard Schema `Config`; services are actually published with `ctx.provide()` or a `Service` constructor. `configSchema(parser)` adapts Nano's existing configuration parsers to Standard Schema.

```ts
import {
  Contributions, CordisContext, defineService, getService, registerCommand,
} from "@nano/runtime-api"
import type { Plugin } from "@nano/runtime-api"

const greeting = defineService<{ greet(name: string): string }>("example.greeting")
const provider: Plugin.Object = {
  name: "example.greeting-provider",
  provide: greeting.name,
  apply(ctx) {
    ctx.provide(greeting.name, { greet: (name: string) => `hello, ${name}` })
  },
}
const command: Plugin.Object = {
  name: "example.greeting-command",
  inject: [greeting.name, "nano.contributions"],
  apply(ctx) {
    const service = getService(ctx, greeting)
    registerCommand(ctx, "example.greet", {
      id: "example.greet",
      execute: (input) => service.greet(String(input)),
    })
  },
}

const ctx = new CordisContext()
await ctx.plugin(Contributions)
await ctx.plugin(provider)
const commandFiber = await ctx.plugin(command)
await commandFiber.dispose()
await ctx.fiber.dispose()
```

Required `inject` dependencies use native availability and reload semantics. `getService(ctx, token)` reads an active service; `findService` returns `undefined` when absent. Optional behavior uses a dynamic lookup or a narrow native `ctx.inject()` child fiber. Nano does not recreate optional-provider restart policy.

Cordis owns listeners and `ctx.effect()` resources. Return a disposer from an effect, or use a native generator effect to group resource teardown where it actually needs local ordering. Top-level effect teardown is concurrent; withdrawing a service does not promise that every dependent resource has already finished cleanup. Runtime application shutdown explicitly stops its conversation runner before disposing the root so final checkpoints can reach persistence. Owned network requests, loops, and registrations use explicit resource-specific abort controllers where needed, not a framework-wide generation signal.

Native fibers expose `state`, `await()`, `dispose()`, `restart()`, `update(config)`, and `getEffects()`. Awaiting a missing-dependency fiber can settle while it remains `PENDING`; it is not an indefinite readiness promise. Disposed fibers cannot restart. Native status events and logger diagnostics are authoritative. There is no Nano generation/error ledger, initialization/disposal timeout policy, staged publication, retry API, or generic sequential cleanup engine.

The conversation `Context` is separate: immutable message/cache lineage and atomic completion commits remain its contract. It is never replaced by the Cordis context.

## Contributions and typed RPC

`Contributions` is an ordinary Cordis `Service` named `nano.contributions`. It stores keyed slot values, owns registration with native effects, and exposes only active-fiber contributions. Plugins using registration/list/watch helpers declare that required service in `inject`.

`defineSlot`, `registerContribution(ctx, slot, key, value)`, `listContributions`, and `watchContributions` provide keyed extension points. Duplicate keys in one slot are rejected. Native lifecycle events notify watchers when owners activate or withdraw. `defineEvent`, `onEvent`, and `emitEvent` provide typed names over native Cordis events; `emitEvent` uses awaited native parallel dispatch.

Tools contribute a model-facing definition and execution callback together. `definitionFor`, `availableFor`, `runtimeKinds`, `clientCapabilities`, `requiresVision`, and `requiresComputer` describe catalog availability. Execution receives the actual plugin context and request cancellation signal. Model providers, compaction strategies, commands, runtime deliveries, and UI extensions use the same ordinary slot service.

```ts
import { defineOperation, defineValidator } from "@nano/protocol"
import { registerOperation } from "@nano/protocol/rpc"
import type { Plugin } from "@nano/plugins"

const echo = defineOperation("example.echo", {
  input: defineValidator<string>((value) => {
    if (typeof value !== "string") throw new TypeError("text must be a string")
    return value
  }),
  output: defineValidator<string>((value) => {
    if (typeof value !== "string") throw new TypeError("output must be a string")
    return value
  }),
  permission: "example.echo",
})
const extension: Plugin.Object = {
  name: "example.extension",
  inject: ["nano.contributions"],
  apply(ctx) { registerOperation(ctx, echo, (text) => text) },
}
```

Only operations/streams registered in `nano.operations`/`nano.streams` are remotely exported. Registration validates inputs and outputs/items and owns its cancellation resource with Cordis effects. Descriptors infer `OperationInput`, `OperationOutput`, `StreamInput`, and `StreamItem`; a stream can supply a resume hook. Local services are not silently exported as RPC, and remote tool execution never fabricates conversation loop state.

Unary RPC is `POST /rpc/:method` with `{ "input": ... }`; success is `{ "value": ... }`, failure is `{ "error": { "code", "message" } }`. WebSocket `/rpc/stream` uses `subscribe`, `item`, `end`, `error`, and `cancel` frames. Token mode uses HTTP Bearer authentication and a WebSocket `auth` frame within five seconds. Limits remain 1,000,000 bytes per body/frame and 128 active streams per connection.

`nano.rpc-auth` accepts `{ mode: "open" | "local-open" | "token", token?, allowedOrigins?, permissions? }`. The default `open` mode preserves access on the configured listener, including remote browsers, without a token. Explicit `local-open` requires a loopback hostname and remote peer. Token mode requires a non-empty token, checks descriptor permissions, and permits `"*"`. Browser origins matching the server's host and port are accepted, including behind HTTPS termination; other origins require `allowedOrigins`, except loopback origins in `local-open` mode. Open modes do not use the permissions list as remote access control. Codes remain `INVALID_ARGUMENT`, `UNAUTHENTICATED`, `PERMISSION_DENIED`, `NOT_FOUND`, `CANCELLED`, `UNAVAILABLE`, and `INTERNAL` (HTTP 400, 401, 403, 404, 499, 503, 500).

Compatibility HTTP/SSE routes remain carriers over those registered contracts: worker `/awp/*`, `/trigger/*`, `/status`, `/chat/stream`, `/metrics`, `/discord/*`, `/client/*`; control `/agents` and `/agents/:id/...`. Existing JSON error and SSE frame shapes remain. Durable worker-event streams subscribe before replay, deduplicate ids, report gaps, and distinguish volatile sequence-zero events from durable cursors. Chat deltas remain live-only.

## Application composition and configuration

`createNanoApplication({ config, plugins, replace, disabled, lifecycle, listen, observability })` from `@nano/runtime/application` creates a fresh Cordis root and installs `Contributions` before selected plugins. Built-ins and statically supplied extras use identical `ctx.plugin()` calls. Selection/replacement uses each native plugin's name before installation; JSON does not load executable code.

The result exposes `ctx`, native `fibers` keyed by name, installed `plugins`, and `close()`. Disabled definitions are not installed. Native functions and classes also work when they provide a name suitable for configuration. Direct Cordis composition remains available without a Nano manager.

`plugins` in runtime JSON maps names to `{ enabled?, config? }`; `enabled` defaults true. Selection validation rejects malformed entries, unknown fields, and non-boolean `enabled`. Native `Config` validates actual activation configuration. See [configuration](config.md). Disposing a capability withdraws owned contributions/services without deleting durable data. Required consumers follow Cordis availability semantics. Without `nano.model-provider`, model dispatch may have no supporting provider; without `nano.rpc-auth`, its required carrier cannot activate.

| Runtime names | Capability |
|---|---|
| `nano.persistence`, `nano.metrics`, `nano.events` | Durable state/sessions, metrics, worker events. |
| `nano.model`, `nano.model-provider` | Model state/dispatch and OpenAI-compatible provider. |
| `nano.bootstrap`, `nano.runner` | Bootstrap and main/frontend conversation runtime. |
| `nano.client`, `nano.embeddings`, `nano.memory`, `nano.discord` | Executor, embeddings, memory, Discord. |
| `nano.context-management`, `nano.context-strategies`, `nano.images` | Context/compaction, strategy slots, images. |
| `nano.jobs`, `nano.subagents`, `nano.agent-channel`, `nano.web-search` | Jobs, subagents, mailbox, web search. |
| `nano.tools`, `nano.tool-families`, `nano.discord-commands` | Tool catalog/contributions and Discord commands. |
| `nano.worker-operations`, `nano.worker-discord-operations`, `nano.worker-client-operations`, `nano.worker-metrics-operations` | Worker RPC exports. |
| `nano.conversation-operations`, `nano.model-operations`, `nano.tools-list-operations` | Generic typed RPC exports. |
| `nano.rpc-auth` | RPC authentication/permissions. |
| `nano.lifecycle`, `nano.observability`, `nano.http` | Conditional lifecycle/exporter/carrier additions. |

The separate control application composes `nano.rpc-auth`, `control.persistence`, `control.discovery`, `control.supervisor`, `control.operations`, `control.static-ui`, and `control.http` from their independent packages. Required control services cannot be disabled; static UI is optional.

## Browser and terminal extensions

`createWebUI(ctx = new CordisContext())` from `@nano/plugin-web-observer` exposes the real `ctx`, UI notification/rendering/action methods, and no plugin-manager facade. `apps/web/src/ui-plugins.tsx` installs `Contributions`, `builtInWebPlugin`, and `createWebObserverPlugin({ onChange: webUI.notifyChanged })` through native `ctx.plugin()` calls.

The four public UI contracts are `WebPanel`, `WebView`, `WebEventRenderer`, and `WebAction`, with their slot tokens and `registerWeb*` helpers. Panels use `left | main | right`, views use `main | right`; event renderers match and render `ChatLine`, and actions receive `execute`. Observers refresh React slot views. Render failures are isolated by the actual React error surface; an unmatched event uses the existing message renderer. Built-ins retain connections/conversation/notes panels and status/history/Discord/compactions views. They do not install server plugins.

Production Vite assets use `/ui/`; the dev proxy retains `/rpc` WebSocket and worker/control paths. Build with `npm run build:web`. The tool-client executor, TUI executor, and TUI chat lifecycle are likewise ordinary public plugins, not private host modules. Their hosts supply Cordis and compose them with the same native API.
