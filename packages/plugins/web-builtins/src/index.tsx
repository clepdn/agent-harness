/** @jsxRuntime automatic */
import type { CordisContext, Plugin } from "@nano/plugins"
import { registerWebPanel, registerWebView, type WebPanel, type WebView } from "@nano/web-api"

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
        : context.chatLines.map((line) => context.renderEvent(line))}
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
      <div className="chat-pane">{context.renderWebViews("main", "history")}</div>
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
      {context.renderWebViews("right")}
    </aside>
  },
}


export const builtInWebPlugin: Plugin = {
  name: "nano.web.builtins",
  inject: ["nano.contributions"],
  apply(ctx: CordisContext) {
    registerWebPanel(ctx, connectionsPanel)
    registerWebPanel(ctx, conversationPanel)
    registerWebPanel(ctx, notesPanel)
    registerWebView(ctx, statusView)
    registerWebView(ctx, historyView)
    registerWebView(ctx, discordView)
    registerWebView(ctx, compactionsView)
  },
}
