# Nano plugin architecture

This describes the implemented trusted, in-process plugin APIs and application composition. Plugin configuration selects code that the application has already installed; it never imports a module named in JSON. The plugin kernel is orchestration, not a sandbox or a substitute for Nano's conversation `Context`.

## Public packages and composition

Use the workspace package entry points: `@nano/plugins` for the generic kernel, `@nano/runtime/plugins` for Nano runtime services and contribution helpers, `@nano/runtime/model` for `Context` and model providers, `@nano/protocol` for shared operation descriptors, and `@nano/protocol/rpc` for RPC registration. The web UI contribution API is currently local to the web application at `apps/web/src/ui-plugins.tsx`; it is not exported as a workspace package. Import public workspace paths, not another package's source files or internal implementation paths.

`Plugin` has a stable `id`, optional `requires`, `optional`, and `provides` service-token declarations, an optional `validate(rawConfig)` function, and `apply(scope, config)`. Tokens are frozen objects: dependency matching uses object identity, not token names. Plugins that exchange a token must import the same token object. Services are synchronous typed in-process calls unless their service contract itself returns a promise. Slots are keyed multi-contributor extension points; events are named asynchronous notifications.

```ts
import { defineService } from "@nano/plugins"
import type { Plugin } from "@nano/plugins"
import { nano, registerCommand } from "@nano/runtime/plugins"

const greeting = defineService<{ greet(name: string): string }>("example.greeting")

const greetingProvider: Plugin = {
  id: "example.greeting-provider",
  provides: [greeting],
  apply(scope) {
    return scope.provide(greeting, {
      greet: scope.guard((name) => `hello, ${name}`),
    })
  },
}

const greetingCommand: Plugin = {
  id: "example.greeting-command",
  requires: [greeting],
  apply(scope) {
    const service = scope.use(greeting)
    registerCommand(scope, "example.greet", {
      id: "example.greet",
      execute: (input) => service.greet(String(input)),
    })
  },
}

// Supply both plugins to createNanoApplication({ plugins: [...] }).
// The command is in nano.commands and is withdrawn with its owner.
void [greetingProvider, greetingCommand, nano.commands]
```

`scope.use(token)` requires a declared, active dependency; `scope.optional(token)` requires a declared optional dependency and returns `undefined` when absent. `scope.provide` requires the token in `provides`. `scope.register(slot, key, value)` adds one keyed contribution; `list` snapshots contributions and `watch` observes changes. `on`/`emit` manage typed events. `own(cleanup)`, `interval`, and `timeout` attach resources to the current plugin generation. Use `scope.guard(callback)` for callbacks retained by another service, so cancellation and thrown/rejected errors are tracked against the owning generation. Registrations and callbacks are removed or invalidated when that generation unloads.

A tool contributes its model-facing definition and execution callback together. `ToolContribution` may use `definitionFor(context)` and `availableFor(context)`, plus `runtimeKinds`, `clientCapabilities`, `requiresVision`, and `requiresComputer`, to describe catalog availability for the `ToolCatalogContext`; execution receives the active plugin and request cancellation signal. There is no need to patch another plugin's catalog or dispatch table.

Slots and operations use the same static contracts rather than modifying a provider:

```ts
import { defineOperation, defineValidator } from "@nano/protocol"
import { registerOperation } from "@nano/protocol/rpc"
import type { Plugin } from "@nano/plugins"
import { defineSlot as definePluginSlot } from "@nano/plugins"

const labels = definePluginSlot<{ label: string }>("example.labels")
const echo = defineOperation("example.echo", {
  input: defineValidator<{ text: string }>((value) => {
    if (!value || typeof value !== "object" || typeof (value as { text?: unknown }).text !== "string") throw new TypeError("text must be a string")
    return value as { text: string }
  }),
  output: defineValidator<string>((value) => {
    if (typeof value !== "string") throw new TypeError("output must be a string")
    return value
  }),
  permission: "example.echo",
})

const extension: Plugin = {
  id: "example.extension",
  apply(scope) {
    scope.register(labels, "community", { label: "Community" })
    registerOperation(scope, echo, async (input, context) => {
      context.signal.throwIfAborted()
      return input.text
    })
  },
}
```

The operation is not remotely reachable until its descriptor is registered in `nano.operations` by this plugin, and its input/output validators run at the boundary. The slot contribution is removed when `example.extension` is disabled or replaced. `defineSlot` above is intentionally imported from `@nano/plugins`; the protocol package's `defineOperation`/`defineValidator` exports are separate contracts.

`createNanoApplication({ config, plugins, replace, disabled, listen, observability })` creates a fresh bus for each application instance. `plugins` adds statically supplied plugin objects; replace a built-in by id through `replace`, not by installing a duplicate. `listen` adds the HTTP/RPC carrier and `observability` adds its exporter. The returned application exposes its bus and closes that bus on `close()`. A generic `PluginBus` also exposes `install`, `replace`, `disable`, `enable`, `retry`, `close`, `get`, `list`, `statuses`, and `inspect`.
The worker and control gateways expose unary `POST /rpc/:method` with `{ "input": ... }` and `{ "value": ... }` success responses. Errors use `{ "error": { "code", "message" } }`. Streams use WebSocket `/rpc/stream`: clients subscribe with `{op:"subscribe", id, method, input}`, receive `item`, then `end` or `error` frames, and cancel with `{op:"cancel", id}`. Token mode authenticates with a Bearer token for HTTP and an `{op:"auth", token}` frame for WebSocket (authentication is required within five seconds); local-open mode requires a loopback hostname and peer. The default body/frame limit is 1,000,000 bytes and the WebSocket gateway allows at most 128 active streams per connection. The client validates frames, can cancel calls/streams, and reconnects/resumes streams using descriptor cursors where defined.
## Lifecycle, ordering, and limits

The bus validates config before `apply`, schedules providers before consumers, and reconciles changes serially. Missing required services leave enabled plugins `PENDING` with `missingDeps`; when a dependency becomes available, the consumer activates. Optional dependency edges are also tracked, so a bound optional provider change can restart its consumer. Duplicate service providers fail dependency planning. A duplicate key in a slot fails the registering plugin; distinct keys can have multiple owners.

Activation stages the resources a plugin registers, then publishes them when apply succeeds. Failed validation or apply rolls registrations back. Disabling, replacing, withdrawing a required service, and closing the bus cancel the relevant generations and unload dependents before providers. Owned resources are detached and cleanups awaited one at a time, in reverse registration order; the cleanup returned by `apply` is disposed before resources registered during apply. Cleanup and initialization have configurable limits (bus defaults: 5 seconds for disposal and 10 seconds for initialization). A timed-out promise is recorded but cannot be forcibly stopped.

Statuses include `PENDING`, `LOADING`, `ACTIVE`, `FAILED`, `UNLOADING`, and `DISPOSED`; errors retain their validation, dependency, apply, callback, or dispose phase and generation. An activation generation guard prevents late asynchronous registrations from an old generation. `retry` re-enables a failed plugin; replacement and dependency recovery trigger reconciliation. `scope.on` contains a listener's thrown/rejected error and records it while other listeners still run. `emit` awaits listeners concurrently. A `scope.guard` wrapper records and rethrows callback errors. These safeguards apply to ordinary callback failures, not process termination, native crashes, OOM, malicious code, or synchronous infinite loops. Abort signals and timeouts are cooperative, not preemption.

The original Nano conversation `Context` is separate from plugin scope: it owns immutable message/cache lineage and atomic completion commits. Plugin services do not replace or mutate that contract. Plugins are trusted code running in the host process. Untrusted extensions require a separate process and an explicitly constrained RPC boundary; an in-process plugin is not a security sandbox.

## Built-in application inventory

The worker composition in `packages/nano-runtime/src/plugins/application.ts` installs these built-ins (each has the shown public selection id):

| IDs | Capability |
|---|---|
| `nano.persistence`, `nano.metrics`, `nano.events` | Durable state/session services, metrics, and worker events. |
| `nano.model`, `nano.model-provider` | Model state/dispatch and the built-in OpenAI-compatible provider. Other providers contribute through the provider slot. |
| `nano.bootstrap`, `nano.runner` | Bootstrap and the main/frontend conversation runner. The runner provides `nano.runner` and `nano.conversation`. |
| `nano.client`, `nano.embeddings`, `nano.memory`, `nano.discord` | Client executor, embeddings, memory, and Discord service. |
| `nano.context-management`, `nano.context-strategies`, `nano.images` | Context/compaction services and strategy slots, image preparation. |
| `nano.jobs`, `nano.subagents`, `nano.agent-channel`, `nano.web-search` | Job management, subagents, durable agent mailbox, and web search. |
| `nano.tools`, `nano.tool-families`, `nano.discord-commands` | Tool service and built-in tool contributions, Discord command adapter. |
| `nano.worker-operations`, `nano.worker-discord-operations`, `nano.worker-client-operations`, `nano.worker-metrics-operations` | Independently registered worker RPC exports for core, Discord, client, and metrics capabilities. |
| `nano.conversation-operations`, `nano.model-operations`, `nano.tools-list-operations` | Conversation, model, and tool-catalog RPC exports. |
| `nano.rpc-auth` | RPC authentication and permission policy. |
| `nano.lifecycle`, `nano.observability`, `nano.http` | Conditional additions: lifecycle is installed when supplied; observability and HTTP are installed when requested in application options. |

The separate control application installs `nano.rpc-auth`, `control.persistence`, `control.discovery`, `control.supervisor`, `control.operations`, `control.static-ui`, and `control.http`. Its HTTP, persistence, discovery, supervisor, and operation services are application-level capabilities rather than worker plugins.

## Typed RPC, auth, and compatibility

`@nano/protocol` defines shared `defineValidator`, `defineOperation`, and `defineStream` contracts. A descriptor carries its name, input validator, output/item validator, and permission (defaulting to its method name); a stream may also define `resume(input, lastItem)`. `OperationInput`, `OperationOutput`, `StreamInput`, and `StreamItem` infer the corresponding TypeScript types. `registerOperation(scope, descriptor, handler)` and `registerStream(scope, descriptor, handler)` validate inputs and outputs/items and bind registration to the contributing generation. Only contributions registered in `nano.operations` or `nano.streams` are remotely exported; the gateway matches the descriptor object, not just an arbitrary method string. Services remain local and transports call the same operation handlers.

The worker and control gateways expose unary `POST /rpc/:method` with `{ "input": ... }` and `{ "value": ... }` success responses. Errors use `{ "error": { "code", "message" } }`. Streams use WebSocket `/rpc/stream`: clients subscribe with `{op:"subscribe", id, method, input}`, receive `item`, then `end` or `error` frames, and cancel with `{op:"cancel", id}`. Token mode authenticates with a Bearer token for HTTP and an `{op:"auth", token}` frame for WebSocket (authentication is required within five seconds); local-open mode authenticates locally. The default body/frame limit is 1,000,000 bytes and the WebSocket gateway allows at most 128 active streams per connection. The client validates frames, can cancel calls/streams, and reconnects/resumes streams using descriptor cursors where defined.

`nano.rpc-auth` accepts `{ mode: "local-open" | "token", token?, allowedOrigins?, permissions? }`. Token mode requires a non-empty token. A supplied Origin must be allowed; local-open requires both a loopback request hostname and a loopback remote peer, and token mode checks the descriptor permission against `permissions` or `"*"`. With local-open, the permissions list is not an access-control list: remote access requires token mode. Standard RPC error codes are `INVALID_ARGUMENT`, `UNAUTHENTICATED`, `PERMISSION_DENIED`, `NOT_FOUND`, `CANCELLED`, `UNAVAILABLE`, and `INTERNAL` (HTTP 400, 401, 403, 404, 499, 503, and 500 respectively). Input/output codec errors are invalid arguments; unknown exports are not found; unknown callback failures become the generic internal error. Request disconnect, explicit stream cancellation, and owner unload abort handler signals.

Built-in descriptor permission families include `control.read`/`control.write`, `worker.read`/`worker.write`, `conversation.read`/`conversation.write`, `model.read`/`model.complete`/`model.stream`, `tools.read`, `discord.read`/`discord.write`, and `metrics.read`. Tool execution remains local to a genuine conversation loop; no remote tool-execute export fabricates loop state. The exact permission is part of each shared descriptor; deployments should grant only the permissions their clients need.

Existing routes remain compatibility carriers over the corresponding registered operation contracts, not alternate business implementations. Worker compatibility routes include `/awp/status`, `/awp/events`, `/awp/stream`, `/trigger/*`, `/status`, `/chat/stream`, `/metrics`, `/discord/*`, and `/client/*`. The control app retains `/agents` and `/agents/:id/...` operations and streams. `@nano/chat-client` supports both unscoped worker paths (`/trigger/chat`, `/status`, `/chat/stream`) and agent-scoped control paths (`/agents/:id/events`, `/agents/:id/status`, `/agents/:id/stream`). Legacy HTTP errors retain their `{error, code}` or `{error}` JSON shapes; their SSE streams retain `data:` frames and stream errors use `event: error`.

Durable worker-event streams subscribe before reading replay, deduplicate by event id, and then deliver queued live events. If the requested cursor predates retained history, the stream yields a gap with the available and latest sequence bounds; clients can resume from the latest cursor. Sequence-zero volatile events are identified as volatile and are not durable replay points. Chat text/thinking deltas use a live stream and do not promise history replay. The RPC WebSocket resume hook and legacy worker SSE route retain these distinctions; the control event stream is also available through SSE.

## Web UI extension API

The web client keeps a separate `PluginBus` and exports `WebApplicationContext`, `WebPanel`, `WebView`, `WebEventRenderer`, `WebAction`, their slot tokens and `registerWebPanel`, `registerWebView`, `registerWebEventRenderer`, `registerWebAction` from `apps/web/src/ui-plugins.tsx`. Panel slots use `left`, `main`, or `right`; view slots use `main` or `right`. Renderers match a `ChatLine` and render it with the current context. Actions wrap an existing UI action. Register via `installWebPlugin(plugin)`; `replaceWebPlugin`, `disableWebPlugin`, `enableWebPlugin`, and `retryWebPlugin` manage a client plugin by id. Each contribution is scoped to its plugin; slot observers update the React UI on changes. Panel/view/render failures show an isolated error state rather than taking down other panels; event-renderer matching failures are displayed, and an unmatched event uses the built-in message renderer.

The built-in web contribution installs connections, conversation, and notes panels, plus status, history, Discord, and compactions views. These are browser client contributions; they do not install server plugins. `apps/web` uses Vite, React, TypeScript strict mode, and `@nano/chat-client`/`@nano/protocol` for RPC contracts. Production assets use the `/ui/` base path and the Vite dev server proxies `/rpc` (including WebSocket) and existing worker/control paths to the backend. Build workspace dependencies with the repository's package scripts before running dependent workspaces; `npm run build:web` builds the browser bundle. Keep cross-workspace imports on declared package exports and keep web-only UI imports within the web application.

## Configuration and disabling capabilities

`plugins` in runtime JSON maps public plugin ids to `{ "enabled": boolean, "config": ... }`; `enabled` defaults to `true`. The selection validator rejects non-object selections, invalid ids, unknown selection fields, and non-boolean `enabled`. It does not load code. `config` passes to the installed plugin's validator; invalid configuration fails that plugin's activation and is visible in bus status. `createNanoApplication` adds statically supplied plugins and built-ins; JSON selects/configures those objects. See [configuration](config.md) for the `nano.rpc-auth` example and control-application restrictions.

Disabling a capability withdraws its owned registrations and service and closes its resources; durable data is not deleted. Required dependents unload first and remain pending while the requirement is missing, then recover when it returns. `nano.discord` is optional to core runner operation, while disabling `nano.persistence` or required runtime dependencies also prevents their consumers from activating. Disabling `nano.model-provider` leaves model dispatch installed but no provider may support inference. Disabling `nano.rpc-auth` prevents the dependent HTTP/RPC carrier from activating. In the control application, required built-ins cannot be disabled; `control.static-ui` is optional, while control HTTP and its required backing services are not. Availability is therefore a dependency graph, not a promise that every feature is independently disableable.
