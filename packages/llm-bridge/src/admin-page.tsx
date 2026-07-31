import { useCallback, useEffect, useRef, useState } from "react"

type LoginProviderId = "anthropic" | "codex"
type LoginKind = "paste" | "device"
type LoginStatus = "awaiting_code" | "polling" | "complete" | "error"

type ProviderStatus = {
  id: LoginProviderId
  name: string
  kind: LoginKind
  authPath: string
  connected: boolean
  expiresAt?: number
  accountId?: string
  error?: string
}

type LoginSession = {
  id: string
  provider: LoginProviderId
  kind: LoginKind
  status: LoginStatus
  createdAt?: number
  expiresAt?: number
  authUrl?: string
  userCode?: string
  verificationUri?: string
  error?: string
}

type ApiError = { error?: { message?: string } }

type ProviderResponse = { providers: ProviderStatus[] }

const KEY_STORE = "llm_bridge_admin_key"

function errorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback
  const message = (body as ApiError).error?.message
  return typeof message === "string" && message ? message : fallback
}

function getStoredKey(): string {
  try {
    return window.sessionStorage.getItem(KEY_STORE) || ""
  } catch {
    return ""
  }
}

function rememberKey(value: string): void {
  try {
    if (value) window.sessionStorage.setItem(KEY_STORE, value)
    else window.sessionStorage.removeItem(KEY_STORE)
  } catch {
    // A blocked sessionStorage should not prevent an already-entered key from working.
  }
}

function formatExpiry(expiresAt?: number): string {
  if (!expiresAt) return "unknown"
  const delta = expiresAt - Date.now()
  if (delta <= 0) return "expired (refreshes on next use)"
  const mins = Math.round(delta / 60000)
  return mins < 60 ? `in ${mins}m` : `in ${Math.round(mins / 60)}h`
}

function AdminGate({ error, onUnlock }: { error?: string; onUnlock: (key: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = () => {
    const key = inputRef.current?.value.trim() || ""
    if (key) onUnlock(key)
  }

  return (
    <div className="card gate">
      <div className="name">admin key</div>
      <p>Paste a bridge API key carrying the <code>admin</code> cap.</p>
      <div className="row">
        <input
          ref={inputRef}
          type="password"
          placeholder="uuid"
          autoComplete="off"
          onKeyDown={(event) => {
            if (event.key === "Enter") submit()
          }}
        />
        <button className="primary" onClick={submit}>unlock</button>
      </div>
      {error ? <div className="err">{error}</div> : null}
    </div>
  )
}

function DeviceFlow({ flow, onCancel }: { flow: LoginSession; onCancel: () => void }) {
  return (
    <div className="flow">
      <p>Open the link, enter this code, and leave this page open.</p>
      <div className="usercode">{flow.userCode || ""}</div>
      <p>
        <a href={flow.verificationUri || ""} target="_blank" rel="noopener">
          {flow.verificationUri || ""}
        </a>{" "}&middot; waiting...
      </p>
      <div className="row"><button onClick={onCancel}>cancel</button></div>
    </div>
  )
}

function PasteFlow({
  provider,
  flow,
  inputRef,
  onSubmit,
  onCancel,
}: {
  provider: LoginProviderId
  flow: LoginSession
  inputRef: (element: HTMLInputElement | null) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const polling = flow.status === "polling"
  return (
    <div className="flow">
      <p>Approve in the tab that opened, then paste what it gives you back &mdash; the code, or the whole redirect URL.</p>
      <div className="row">
        <input data-code={provider} ref={inputRef} placeholder="code#state or full URL" autoComplete="off" onKeyDown={(event) => {
          if (event.key === "Enter") onSubmit()
        }} />
        <button className="primary" disabled={polling} onClick={onSubmit}>{polling ? "finishing..." : "finish"}</button>
        <button onClick={onCancel}>cancel</button>
      </div>
    </div>
  )
}

function Flow({
  provider,
  flow,
  codeInputRef,
  onSubmitCode,
  onCancel,
}: {
  provider: ProviderStatus
  flow?: LoginSession
  codeInputRef: (element: HTMLInputElement | null) => void
  onSubmitCode: () => void
  onCancel: () => void
}) {
  if (!flow) return null
  if (flow.status === "complete") return <div className="flow"><p className="on">signed in.</p></div>
  if (flow.status === "error") return <div className="flow"><p className="bad">{flow.error || "login failed"}</p></div>
  if (provider.kind === "device") return <DeviceFlow flow={flow} onCancel={onCancel} />
  return <PasteFlow provider={provider.id} flow={flow} inputRef={codeInputRef} onSubmit={onSubmitCode} onCancel={onCancel} />
}

function ProviderCard({
  provider,
  flow,
  codeInputRef,
  onLogin,
  onLogout,
  onCancel,
  onSubmitCode,
}: {
  provider: ProviderStatus
  flow?: LoginSession
  codeInputRef: (element: HTMLInputElement | null) => void
  onLogin: () => void
  onLogout: () => void
  onCancel: () => void
  onSubmitCode: () => void
}) {
  const state = provider.error
    ? <span className="state bad">error</span>
    : provider.connected
      ? <span className="state on">connected</span>
      : <span className="state off">not connected</span>
  const busy = flow?.status === "awaiting_code" || flow?.status === "polling"

  return (
    <div className="card">
      <div className="card-head"><span className="name">{provider.name}</span>{state}</div>
      <dl>
        {provider.connected && provider.expiresAt ? <><dt>renews</dt><dd>{formatExpiry(provider.expiresAt)}</dd></> : null}
        {provider.accountId ? <><dt>account</dt><dd>{provider.accountId}</dd></> : null}
        <dt>file</dt><dd>{provider.authPath}</dd>
      </dl>
      {provider.error ? <div className="err">{provider.error}</div> : null}
      <div className="row">
        <button className="primary" disabled={busy} onClick={onLogin}>{provider.connected ? "sign in again" : "sign in"}</button>
        {provider.connected ? <button className="danger" onClick={onLogout}>sign out</button> : null}
      </div>
      <Flow
        provider={provider}
        flow={flow}
        codeInputRef={codeInputRef}
        onSubmitCode={onSubmitCode}
        onCancel={onCancel}
      />
    </div>
  )
}

export function AdminApp() {
  const [adminKey, setAdminKey] = useState(getStoredKey)
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null)
  const [flows, setFlows] = useState<Record<string, LoginSession>>({})
  const [error, setError] = useState<string>()
  const timers = useRef<Record<string, number>>({})
  const flowsRef = useRef<Record<string, LoginSession>>({})
  const codeInputs = useRef<Record<string, HTMLInputElement | null>>({})

  const setFlow = useCallback((provider: string, flow: LoginSession | undefined) => {
    setFlows((previous) => {
      const next = { ...previous }
      if (flow) next[provider] = flow
      else delete next[provider]
      flowsRef.current = next
      return next
    })
  }, [])

  const api = useCallback(async (path: string, init: RequestInit = {}): Promise<any> => {
    const response = await fetch(`/admin/api${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${adminKey}`,
      },
    })
    if (response.status === 401 || response.status === 403) {
      rememberKey("")
      setAdminKey("")
      const body = await response.json().catch(() => null)
      throw new Error(errorMessage(body, "not authorised"))
    }
    if (response.status === 204) return null
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new Error(errorMessage(body, `${response.status} ${response.statusText}`))
    return body
  }, [adminKey])

  const stop = useCallback((provider: string) => {
    const timer = timers.current[provider]
    if (timer !== undefined) {
      window.clearInterval(timer)
      delete timers.current[provider]
    }
  }, [])

  const load = useCallback(async () => {
    if (!adminKey) return
    try {
      const data = await api("/providers") as ProviderResponse
      setProviders(data.providers)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [adminKey, api])

  useEffect(() => {
    if (!adminKey) {
      setProviders(null)
      return
    }
    let cancelled = false
    setError(undefined)
    void load().catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => {
      cancelled = true
      for (const provider of Object.keys(timers.current)) stop(provider)
    }
  }, [adminKey, load, stop])

  const watch = useCallback((provider: string) => {
    stop(provider)
    timers.current[provider] = window.setInterval(async () => {
      const flow = flowsRef.current[provider]
      if (!flow?.id) return stop(provider)
      try {
        const next = await api(`/session/${flow.id}`) as LoginSession
        setFlow(provider, next)
        if (next.status === "complete" || next.status === "error") {
          stop(provider)
          await load()
        }
      } catch {
        stop(provider)
      }
    }, 2500)
  }, [api, load, setFlow, stop])

  const login = useCallback(async (provider: ProviderStatus) => {
    try {
      const flow = await api(`/login/${provider.id}`, { method: "POST" }) as LoginSession
      setFlow(provider.id, flow)
      if (flow.authUrl) window.open(flow.authUrl, "_blank", "noopener")
      watch(provider.id)
      await load()
    } catch (reason: unknown) {
      setFlow(provider.id, { id: "", provider: provider.id, kind: provider.kind, status: "error", error: reason instanceof Error ? reason.message : String(reason) })
      stop(provider.id)
      await load().catch(() => {})
    }
  }, [api, load, setFlow, stop, watch])

  const submitCode = useCallback(async (provider: ProviderStatus, code: string) => {
    const flow = flowsRef.current[provider.id]
    if (!flow || !code.trim()) return
    try {
      const next = await api(`/session/${flow.id}/code`, {
        method: "POST",
        body: JSON.stringify({ code: code.trim() }),
      }) as LoginSession
      setFlow(provider.id, next)
    } catch (reason: unknown) {
      setFlow(provider.id, { ...flow, status: "error", error: reason instanceof Error ? reason.message : String(reason) })
      stop(provider.id)
    }
    await load().catch(() => {})
  }, [api, load, setFlow, stop])

  const cancel = useCallback(async (provider: ProviderStatus) => {
    const flow = flowsRef.current[provider.id]
    stop(provider.id)
    if (flow?.id) await api(`/session/${flow.id}`, { method: "DELETE" }).catch(() => {})
    setFlow(provider.id, undefined)
    await load().catch(() => {})
  }, [api, load, setFlow, stop])

  const signOut = useCallback(async (provider: ProviderStatus) => {
    try {
      await api(`/logout/${provider.id}`, { method: "POST" })
      setFlow(provider.id, undefined)
    } catch {
      // The reload below surfaces auth failures and refreshed provider status.
    }
    await load().catch(() => {})
  }, [api, load, setFlow])

  useEffect(() => () => {
    for (const provider of Object.keys(timers.current)) stop(provider)
  }, [stop])

  const unlock = (key: string) => {
    rememberKey(key)
    setError(undefined)
    setAdminKey(key)
  }

  if (!adminKey) return <AdminGate error={error} onUnlock={unlock} />
  if (error) return <div className="card"><div className="err">{error}</div></div>
  if (!providers) return <div className="card"><div className="name">loading...</div></div>

  return (
    <>
      <h1>llm bridge</h1>
      <p className="sub">subscription logins</p>
      {providers.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          flow={flows[provider.id]}
          codeInputRef={(element) => { codeInputs.current[provider.id] = element }}
          onLogin={() => void login(provider)}
          onLogout={() => void signOut(provider)}
          onCancel={() => void cancel(provider)}
          onSubmitCode={() => void submitCode(provider, codeInputs.current[provider.id]?.value || "")}
        />
      ))}
    </>
  )
}
