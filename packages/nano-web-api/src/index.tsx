/** @jsxRuntime automatic */
import * as React from "react"
import { Component, type FormEvent, type ReactNode } from "react"
import { CordisContext, defineSlot, listContributions, registerContribution } from "@nano/plugins"
import type {
  OperationOutput,
  StreamItem,
  controlAgentOverview,
  controlAgentStream,
  controlAgentsList,
  controlDiscordChannels,
  controlDiscordMessages,
} from "@nano/protocol"

export type Panel = {
  id: string
  name: string
  baseUrl: string
  /** Gateway credential held only for this browser session; never persisted. */
  token?: string
}

export type Agent = OperationOutput<typeof controlAgentsList>["agents"][number]
export type WorkerStatus = Extract<NonNullable<OperationOutput<typeof controlAgentOverview>["status"]>, { running: boolean }>
export type Compaction = OperationOutput<typeof controlAgentOverview>["compactions"][number]
export type WorkerEvent = StreamItem<typeof controlAgentStream>
export type DiscordChannel = OperationOutput<typeof controlDiscordChannels>["channels"][number]
export type DiscordMessage = OperationOutput<typeof controlDiscordMessages>["messages"][number]

export type ChatLine = {
  key: string
  seq: number
  at: string
  kind: "agent" | "user" | "tool" | "note" | "context" | "error" | "thinking"
  label: string
  text: string
  detail?: string
  toolArgs?: string
  toolResult?: string
  toolStatus?: "running" | "complete" | "error"
}

export type ToolCallView = { id: string; name: string; arguments: unknown }

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
  renderEvent(line: ChatLine): ReactNode
  renderWebViews(placement: WebView["placement"], id?: string): ReactNode
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

export function registerWebPanel(ctx: CordisContext, panel: WebPanel): () => void | Promise<void> {
  return registerContribution(ctx, webPanelSlot, panel.id, panel)
}

export function registerWebView(ctx: CordisContext, view: WebView): () => void | Promise<void> {
  return registerContribution(ctx, webViewSlot, view.id, view)
}

export function registerWebEventRenderer(ctx: CordisContext, renderer: WebEventRenderer): () => void | Promise<void> {
  return registerContribution(ctx, webEventRendererSlot, renderer.id, renderer)
}

export function registerWebAction(ctx: CordisContext, action: WebAction): () => void | Promise<void> {
  return registerContribution(ctx, webActionSlot, action.id, action)
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

export type WebUI = {
  readonly ctx: CordisContext
  notifyChanged(): void
  renderWebPanels(placement: WebPanel["placement"], context: WebApplicationContext): ReactNode
  renderWebViews(placement: WebView["placement"], context: WebApplicationContext, id?: string): ReactNode
  renderWebEvent(line: ChatLine, context: WebApplicationContext): ReactNode
  invokeWebAction(id: string, execute: () => void | Promise<void>): Promise<void>
}

/** Create an isolated UI view host over a native Cordis context. */
export function createWebUI(ctx = new CordisContext()): WebUI {
  const listeners = new Set<() => void>()
  let version = 0

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const notifyChanged = (): void => {
    version++
    for (const listener of listeners) listener()
  }
  const getVersion = (): number => version

  function WebViewContribution({ owner, view, context }: { owner: string; view: WebView; context: WebApplicationContext }): ReactNode {
    return <PanelErrorBoundary owner={`${owner}:${view.id}`} resetKey={`${version}:${context.selectedKey}`} render={() => view.render(context)} />
  }

  function WebViewSlot({ placement, id, context }: { placement: WebView["placement"]; id?: string; context: WebApplicationContext }): ReactNode {
    React.useSyncExternalStore(subscribe, getVersion, getVersion)
    const entries = listContributions(ctx, webViewSlot).filter((entry) => entry.value.placement === placement && (!id || entry.key === id))
    if (id && !entries.length) return <p className="error-line">No UI plugin contributed the {id} view.</p>
    return entries.map(({ key, owner, value }) => <WebViewContribution key={`${owner}:${key}:${version}`} owner={owner} view={value} context={context} />)
  }

  function WebPanelSlot({ placement, context }: { placement: WebPanel["placement"]; context: WebApplicationContext }): ReactNode {
    React.useSyncExternalStore(subscribe, getVersion, getVersion)
    const entries = listContributions(ctx, webPanelSlot).filter((entry) => entry.value.placement === placement)
    if (!entries.length) return <p className="error-line">No UI plugins contributed to the {placement} panel area.</p>
    return entries.map(({ key, owner, value }) => <PanelErrorBoundary key={`${owner}:${key}:${version}`} owner={`${owner}:${key}`} resetKey={`${version}:${context.selectedKey}`} render={() => value.render(context)} />)
  }

  function WebEventSlot({ line, context }: { line: ChatLine; context: WebApplicationContext }): ReactNode {
    React.useSyncExternalStore(subscribe, getVersion, getVersion)
    const entries = listContributions(ctx, webEventRendererSlot)
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
    return <PanelErrorBoundary owner={`${renderer.owner}:${renderer.key}`} resetKey={`${version}:${line.key}`} render={() => renderer.value.render(line, context)} />
  }


  return {
    ctx,
    notifyChanged,
    renderWebPanels(placement, context) {
      return <WebPanelSlot placement={placement} context={context} />
    },
    renderWebViews(placement, context, id) {
      return <WebViewSlot placement={placement} context={context} id={id} />
    },
    renderWebEvent(line, context) {
      return <WebEventSlot line={line} context={context} />
    },
    async invokeWebAction(id, execute) {
      const actions = listContributions(ctx, webActionSlot).filter((entry) => entry.key === id)
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
    },
  }
}
