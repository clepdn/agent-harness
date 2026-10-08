/** @jsxRuntime automatic */
import * as React from "react"
import { Component, type ReactNode } from "react"
import { CordisContext, listContributions } from "@nano/plugins"
import {
  webActionSlot,
  webEventRendererSlot,
  webPanelSlot,
  webViewSlot,
  type ChatLine,
  type WebApplicationContext,
  type WebPanel,
  type WebUI,
  type WebView,
} from "@nano/web-api"


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
