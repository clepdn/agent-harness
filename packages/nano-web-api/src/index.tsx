import type * as React from "react"
import type { FormEvent, ReactNode } from "react"
import { CordisContext, defineSlot, registerContribution } from "@nano/plugins"
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

export type WebUI = {
  readonly ctx: CordisContext
  notifyChanged(): void
  renderWebPanels(placement: WebPanel["placement"], context: WebApplicationContext): ReactNode
  renderWebViews(placement: WebView["placement"], context: WebApplicationContext, id?: string): ReactNode
  renderWebEvent(line: ChatLine, context: WebApplicationContext): ReactNode
  invokeWebAction(id: string, execute: () => void | Promise<void>): Promise<void>
}
