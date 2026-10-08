import * as React from "react"
import { Component, type FormEvent, type ReactNode } from "react"
import { PluginBus, defineSlot, type Plugin, type PluginScope } from "@nano/plugins"
import type { ChatLine, DiscordChannel, DiscordMessage, Panel, Agent, WorkerStatus, Compaction, WorkerEvent } from "./App"

export type WebApplicationContext = {
  panels: Panel[]
  agentsByPanel: Record<string, Agent[]>
  selectedKey: string
  selected: { panel: Panel; agent: Agent } | null
  selectedAgentName: string
  error: string
  status: WorkerStatus | null
  chatLines: ChatLine[]
  expandedTools: Set<string>
  toggleTool(key: string): void
  refresh(): void
  connect(event: FormEvent<HTMLFormElement>): void
  remove(panelId: string): void
  selectAgent(key: string): void
  panelNameDraft: string
  setPanelNameDraft(value: string): void
  panelDraft: string
  setPanelDraft(value: string): void
  panelTokenDraft: string
  setPanelTokenDraft(value: string): void
  input: string
  setInput(value: string): void
  busy: boolean
  send(event: FormEvent<HTMLFormElement>): void
  notesWidth: number
  notesWidthMin: number
  notesWidthMax: number
  startNotesResize(event: React.PointerEvent<HTMLDivElement>): void
  moveNotesResize(event: React.PointerEvent<HTMLDivElement>): void
  endNotesResize(event: React.PointerEvent<HTMLDivElement>): void
  handleNotesResizeKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void
  overviewStatusText(status: WorkerStatus | null): string
  clientStatusText(status: WorkerStatus | null): string
  formatTime(value: string | undefined): string
  formatDuration(value: number | undefined): string
  formatNumber(value: number | undefined): string
  discordChannelLabel(channel: DiscordChannel): string
  discordChannels: DiscordChannel[]
  selectedDiscordChannel: string | null
  selectDiscordChannel(id: string): void
  discordLoading: boolean
  discordMessages: DiscordMessage[]
  compactions: Compaction[]
  openCompaction: string | null
  toggleCompaction(key: string): void
  renderMessage(line: ChatLine, expanded: boolean): ReactNode
}

export type WebPanel = {
  id: string
  placement: "left" | "main" | "right"
  render(context: WebApplicationContext): ReactNode
}

export type WebView = {
  id: string
  placement: "main" | "right"
  render(context: WebApplicationContext): ReactNode
}

export type WebEventRenderer = {
  id: string
  accepts(event: ChatLine): boolean
  render(event: ChatLine, context: WebApplicationContext): ReactNode
}

export type WebAction = {
  id: string
  run(input: { execute(): void | Promise<void> }): void | Promise<void>
}

export const webPanelSlot = defineSlot<WebPanel>("nano.web.panels")
export const webViewSlot = defineSlot<WebView>("nano.web.views")
export const webEventRendererSlot = defineSlot<WebEventRenderer>("nano.web.event-renderers")
export const webActionSlot = defineSlot<WebAction>("nano.web.actions")

export function registerWebPanel(scope: PluginScope, panel: WebPanel): () => void {
  return scope.register(webPanelSlot, panel.id, { ...panel, render: scope.guard(panel.render) })
}

export function registerWebView(scope: PluginScope, view: WebView): () => void {
  return scope.register(webViewSlot, view.id, { ...view, render: scope.guard(view.render) })
}

export function registerWebEventRenderer(scope: PluginScope, renderer: WebEventRenderer): () => void {
  return scope.register(webEventRendererSlot, renderer.id, {
    ...renderer,
    accepts: scope.guard(renderer.accepts),
    render: scope.guard(renderer.render),
  })
}

export function registerWebAction(scope: PluginScope, action: WebAction): () => void {
  return scope.register(webActionSlot, action.id, { ...action, run: scope.guard(action.run) })
}

class PanelErrorBoundary extends Component<{ owner: string; render(): ReactNode; resetKey?: unknown }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidUpdate(previousProps: Readonly<{ owner: string; render(): ReactNode; resetKey?: unknown }>): void {
    if (this.state.failed && previousProps.resetKey !== this.props.resetKey) this.setState({ failed: false })
  }

  render(): ReactNode {
    return this.state.failed
      ? <p className="error-line">UI plugin {this.props.owner} failed; other panels remain available.</p>
      : <PluginRender render={this.props.render} />
  }
}

function PluginRender({ render }: { render: () => ReactNode }): ReactNode {
  return render()
}

function pluginError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function PluginFailure({ owner, operation, error }: { owner: string; operation: string; error: unknown }): ReactNode {
  return <p className="error-line">UI plugin {owner} {operation} failed: {pluginError(error)}</p>
}

const webUiListeners = new Set<() => void>()
let webUiVersion = 0

function subscribeWebUi(listener: () => void): () => void {
  webUiListeners.add(listener)
  return () => webUiListeners.delete(listener)
}

function notifyWebUi(): void {
  webUiVersion++
  for (const listener of webUiListeners) listener()
}

function WebViewContribution({ owner, view, context }: { owner: string; view: WebView; context: WebApplicationContext }): ReactNode {
  return <PanelErrorBoundary owner={`${owner}:${view.id}`} resetKey={`${webUiVersion}:${context.selectedKey}`} render={() => view.render(context)} />
}

function WebViewSlot({ placement, id, context }: { placement: WebView["placement"]; id?: string; context: WebApplicationContext }): ReactNode {
  React.useSyncExternalStore(subscribeWebUi, () => webUiVersion, () => webUiVersion)
  const entries = webUiBus.list(webViewSlot).filter((entry) => entry.value.placement === placement && (!id || entry.key === id))
  if (id && !entries.length) return <p className="error-line">No UI plugin contributed the {id} view.</p>
  return entries.map(({ key, owner, value }) => <WebViewContribution key={`${owner}:${key}:${webUiVersion}`} owner={owner} view={value} context={context} />)
}

const statusView: WebView = {
  id: "status",
  placement: "right",
  render(context) {
    const { status } = context
    return <section>
      <h2>status</h2>
      <dl>
        <div><dt>state</dt><dd>{context.overviewStatusText(status)}</dd></div>
        <div><dt>context</dt><dd>{context.formatNumber(status?.contextSize)}</dd></div>
        <div><dt>tokens</dt><dd>{context.formatNumber(status?.tokenCount)}</dd></div>
        <div><dt>uptime</dt><dd>{context.formatDuration(status?.uptimeMs)}</dd></div>
      </dl>
    </section>
  },
}

const historyView: WebView = {
  id: "history",
  placement: "main",
  render(context) {
    return <div className="messages">
      {context.chatLines.length === 0
        ? <p className="empty">No mirrored history yet. Send a message or open the stream to start collecting it.</p>
        : context.chatLines.map((line) => renderWebEvent(line, context))}
    </div>
  },
}

const discordView: WebView = {
  id: "discord",
  placement: "right",
  render(context) {
    return <section>
      <h2>discord history</h2>
      {context.discordChannels.length === 0 ? <p className="quiet">no channels mirrored yet</p> : null}
      <div className="discord-history">
        <div className="discord-channels">
          {context.discordChannels.map((channel) => <button
            key={channel.channel_id}
            type="button"
            className={channel.channel_id === context.selectedDiscordChannel ? "discord-channel is-current" : "discord-channel"}
            onClick={() => context.selectDiscordChannel(channel.channel_id)}
          >
            <span>{context.discordChannelLabel(channel)}</span>
            <small>{channel.guild_name || "dm"}</small>
          </button>)}
        </div>
        {context.selectedDiscordChannel ? <div className="discord-messages">
          {context.discordLoading ? <p className="quiet">loading...</p> : null}
          {!context.discordLoading && context.discordMessages.length === 0 ? <p className="quiet">no messages</p> : null}
          {context.discordMessages.map((message) => <article key={message.message_id}>
            <div><strong>{message.author_username || "unknown"}</strong><time>{context.formatTime(message.created_at)}</time></div>
            <p>{message.content || "(attachment or empty message)"}</p>
          </article>)}
        </div> : null}
      </div>
    </section>
  },
}

const compactionsView: WebView = {
  id: "compactions",
  placement: "right",
  render(context) {
    return <section>
      <h2>recent compactions</h2>
      {context.compactions.length === 0 ? <p className="quiet">none mirrored yet</p> : null}
      <div className="compactions">
        {context.compactions.map((item) => {
          const key = item.eventId
          const open = context.openCompaction === key
          return <article key={key}>
            <button type="button" onClick={() => context.toggleCompaction(open ? "" : key)}>
              <span>{context.formatTime(item.timestamp)}</span>
              <strong>{context.formatNumber(item.savedTokens)} saved</strong>
              <small>{item.method ?? "compaction"}</small>
            </button>
            {open ? <p>{item.summary || "(no summary stored)"}</p> : null}
          </article>
        })}
      </div>
    </section>
  },
}

const connectionsPanel: WebPanel = {
  id: "connections",
  placement: "left",
  render(context) {
    return <aside className="connections" aria-label="control panels">
      <header><h1>nano</h1><button type="button" onClick={() => context.refresh()}>refresh</button></header>
      <form className="connect-form" onSubmit={context.connect}>
        <input value={context.panelNameDraft} onChange={(event) => context.setPanelNameDraft(event.target.value)} placeholder="name" aria-label="control panel name" />
        <input value={context.panelDraft} onChange={(event) => context.setPanelDraft(event.target.value)} placeholder="https://control.example" aria-label="control panel url" />
        <input type="password" value={context.panelTokenDraft} onChange={(event) => context.setPanelTokenDraft(event.target.value)} placeholder="gateway token (optional)" aria-label="gateway token" autoComplete="off" />
        <button type="submit">connect</button>
      </form>
      <div className="agent-list">{context.panels.map((panel) => <section key={panel.id}>
        <div className="panel-line"><span>{panel.name}</span>{panel.id !== "same-origin" ? <button type="button" onClick={() => context.remove(panel.id)} aria-label={`remove ${panel.name}`}>remove</button> : null}</div>
        {(context.agentsByPanel[panel.id] ?? []).map((agent) => {
          const key = `${panel.id}::${agent.id}`
          return <button key={key} type="button" className={key === context.selectedKey ? "agent-button is-current" : "agent-button"} onClick={() => context.selectAgent(key)}>
            <span>{agent.name}</span><small>{agent.status}</small>
          </button>
        })}
        {(context.agentsByPanel[panel.id] ?? []).length === 0 ? <p className="quiet">no agents</p> : null}
      </section>)}</div>
    </aside>
  },
}

const conversationPanel: WebPanel = {
  id: "conversation",
  placement: "main",
  render(context) {
    return <section className="thread" aria-label="agent conversation">
      <header className="thread-head">
        <div><h2>{context.selected ? context.selected.agent.name : "choose an agent"}</h2>
          <p>{context.overviewStatusText(context.status)}{context.status?.processStartedAt ? ` since ${context.formatTime(context.status.processStartedAt)}` : ""}</p>
          <p className="quiet">{context.clientStatusText(context.status)}</p>
        </div>
        <div className="readout" aria-label="current token status"><span>{context.formatNumber(context.status?.contextSize)} ctx</span><span>{context.formatNumber(context.status?.tokenCount)} total</span><span>{context.formatDuration(context.status?.uptimeMs)}</span></div>
      </header>
      {context.error ? <p className="error-line">{context.error}</p> : null}
      <div className="chat-pane"><WebViewSlot placement="main" id="history" context={context} /></div>
      <form className="composer" onSubmit={context.send}>
        <input value={context.input} onChange={(event) => context.setInput(event.target.value)} disabled={!context.selected || context.busy} placeholder={context.selected ? `message ${context.selected.agent.name}` : "choose an agent first"} aria-label="message" />
        <button type="submit" disabled={!context.selected || context.busy || !context.input.trim()}>{context.busy ? "sending" : "send"}</button>
      </form>
    </section>
  },
}

const notesPanel: WebPanel = {
  id: "notes",
  placement: "right",
  render(context) {
    return <aside className="notes" aria-label="agent notes">
      <div className="notes-resizer" role="separator" aria-label="resize right rail" aria-orientation="vertical" aria-valuemin={context.notesWidthMin} aria-valuemax={context.notesWidthMax} aria-valuenow={context.notesWidth} tabIndex={0}
        onPointerDown={context.startNotesResize} onPointerMove={context.moveNotesResize} onPointerUp={context.endNotesResize} onPointerCancel={context.endNotesResize} onKeyDown={context.handleNotesResizeKeyDown} />
      <WebViewSlot placement="right" context={context} />
    </aside>
  },
}

const builtInWebPlugin: Plugin = {
  id: "nano.web.builtins",
  apply(scope: PluginScope) {
    registerWebPanel(scope, connectionsPanel)
    registerWebPanel(scope, conversationPanel)
    registerWebPanel(scope, notesPanel)
    registerWebView(scope, statusView)
    registerWebView(scope, historyView)
    registerWebView(scope, discordView)
    registerWebView(scope, compactionsView)
  },
}
const webUiBus = new PluginBus()
const webUiObserverPlugin: Plugin = {
  id: "nano.web.observer",
  apply(scope: PluginScope) {
    scope.watch(webPanelSlot, () => notifyWebUi())
    scope.watch(webViewSlot, () => notifyWebUi())
    scope.watch(webEventRendererSlot, () => notifyWebUi())
    scope.watch(webActionSlot, () => notifyWebUi())
  },
}
export const webUiReady = webUiBus.install(builtInWebPlugin)
  .then(() => webUiBus.install(webUiObserverPlugin))

/** Install a client plugin that contributes to the public web slots. */
export function installWebPlugin(plugin: Plugin): Promise<void> {
  return webUiBus.install(plugin)
}

export function replaceWebPlugin(plugin: Plugin): Promise<void> {
  return webUiBus.replace(plugin)
}

export function disableWebPlugin(id: string): Promise<void> {
  return webUiBus.disable(id)
}

export function enableWebPlugin(id: string): Promise<void> {
  return webUiBus.enable(id)
}

export function retryWebPlugin(id: string): Promise<void> {
  return webUiBus.retry(id)
}

function WebPanelSlot({ placement, context }: { placement: WebPanel["placement"]; context: WebApplicationContext }): ReactNode {
  React.useSyncExternalStore(subscribeWebUi, () => webUiVersion, () => webUiVersion)
  const entries = webUiBus.list(webPanelSlot).filter((entry) => entry.value.placement === placement)
  if (!entries.length) return <p className="error-line">No UI plugins contributed to the {placement} panel area.</p>
  return entries.map(({ key, owner, value }) => <PanelErrorBoundary key={`${owner}:${key}:${webUiVersion}`} owner={owner} resetKey={`${webUiVersion}:${context.selectedKey}`} render={() => value.render(context)} />)
}

export function renderWebPanels(placement: WebPanel["placement"], context: WebApplicationContext): ReactNode {
  return <WebPanelSlot placement={placement} context={context} />
}

export function renderWebEvent(line: ChatLine, context: WebApplicationContext): ReactNode {
  const entries = webUiBus.list(webEventRendererSlot)
  let renderer: typeof entries[number] | undefined
  let matcherError: { owner: string; error: unknown } | undefined
  for (const entry of entries) {
    try {
      if (entry.value.accepts(line)) {
        renderer = entry
        break
      }
    } catch (error) {
      matcherError = { owner: `${entry.owner}:${entry.key}`, error }
      break
    }
  }
  if (matcherError) return <PluginFailure owner={matcherError.owner} operation="event matching" error={matcherError.error} />
  if (!renderer) return context.renderMessage(line, context.expandedTools.has(line.key))
  return <PanelErrorBoundary owner={`${renderer.owner}:${renderer.key}`} resetKey={`${webUiVersion}:${line.key}`} render={() => renderer.value.render(line, context)} />
}

export async function invokeWebAction(id: string, execute: () => void | Promise<void>): Promise<void> {
  const actions = webUiBus.list(webActionSlot).filter((entry) => entry.key === id)
  if (!actions.length) {
    await execute()
    return
  }
  const failures: string[] = []
  await Promise.all(actions.map(async ({ value, owner, key }) => {
    try {
      await value.run({ execute })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${owner}:${key}: ${message}`)
      console.error(`UI plugin ${owner}:${key} action failed`, error)
    }
  }))
  if (failures.length) throw new Error(failures.join("; "))
}
