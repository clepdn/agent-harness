import assert from "node:assert/strict"
import { test } from "node:test"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { JSDOM } from "jsdom"
import { AdminApp } from "./admin-page"

test("polling an unchanged login keeps the code input and focus intact", async () => {
  const dom = new JSDOM("<!doctype html><body><main id=app></main></body>", { url: "https://bridge.test/admin" })
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousFetch = globalThis.fetch
  const previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  const previousSetInterval = dom.window.setInterval
  const previousClearInterval = dom.window.clearInterval
  let poll: (() => Promise<void>) | undefined
  let root: ReturnType<typeof createRoot> | undefined

  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window })
  Object.defineProperty(dom.window.document, "documentMode", { value: undefined })
  ;(dom.window.HTMLElement.prototype as HTMLElement & { attachEvent?: () => void }).attachEvent = () => {}
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  dom.window.sessionStorage.setItem("llm_bridge_admin_key", "admin-key")
  dom.window.setInterval = ((callback: TimerHandler) => {
    poll = callback as () => Promise<void>
    return 1
  }) as typeof dom.window.setInterval
  dom.window.clearInterval = (() => {}) as typeof dom.window.clearInterval

  const providers = {
    providers: [{
      id: "anthropic",
      name: "Claude Pro/Max",
      kind: "paste",
      authPath: "/tmp/auth.json",
      connected: false,
    }],
  }
  const session = { id: "flow-1", provider: "anthropic", kind: "paste", status: "awaiting_code" as const }
  let sessionStatus: "awaiting_code" | "complete" = "awaiting_code"
  let failProviderReload = false
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input)
    if (path.endsWith("/providers") && failProviderReload) {
      return {
        status: 502,
        ok: false,
        statusText: "Bad Gateway",
        json: async () => ({ error: { message: "provider reload failed" } }),
      } as Response
    }
    const body = path.endsWith("/providers")
      ? providers
      : path.endsWith("/login/anthropic")
        ? session
        : { ...session, status: sessionStatus }
    return {
      status: 200,
      ok: true,
      statusText: "OK",
      json: async () => body,
    } as Response
  }) as typeof fetch

  try {
    root = createRoot(dom.window.document.getElementById("app")!)
    await act(async () => {
      root!.render(<AdminApp />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const login = [...dom.window.document.querySelectorAll("button")].find((button) => button.textContent === "sign in")
    assert.ok(login)
    await act(async () => {
      login.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    const input = dom.window.document.querySelector<HTMLInputElement>('[data-code="anthropic"]')
    assert.ok(input)
    input.value = "code#state"
    input.focus()
    assert.equal(dom.window.document.activeElement, input)
    assert.ok(poll)

    await act(async () => {
      await poll!()
      await Promise.resolve()
    })

    const currentInput = dom.window.document.querySelector<HTMLInputElement>('[data-code="anthropic"]')
    assert.equal(currentInput, input)
    assert.equal(currentInput?.value, "code#state")
    assert.equal(dom.window.document.activeElement, input)
    sessionStatus = "complete"
    failProviderReload = true
    await act(async () => {
      await poll!()
      await Promise.resolve()
    })
    assert.match(dom.window.document.body.textContent || "", /provider reload failed/)
  } finally {
    if (root) {
      await act(async () => {
        root!.unmount()
        await Promise.resolve()
      })
      root = undefined
    }
    dom.window.setInterval = previousSetInterval
    dom.window.clearInterval = previousClearInterval
    if (previousWindow) Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
    else delete (globalThis as { window?: unknown }).window
    if (previousDocument) Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument })
    else delete (globalThis as { document?: unknown }).document
    globalThis.fetch = previousFetch
    if (previousActEnvironment === undefined) delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
    else (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})
