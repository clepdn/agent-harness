import assert from "node:assert/strict"
import { test } from "node:test"
import vm from "node:vm"
import { adminPage } from "./admin-page"

test("polling an unchanged login keeps the code input intact", async () => {
  const script = adminPage().match(/<script>([\s\S]*)<\/script>/)?.[1]
  assert.ok(script)

  let poll: (() => Promise<void>) | undefined
  let renders = 0
  let codeInput = { value: "" }
  const app = {
    innerHTML: "",
    querySelectorAll: () => [],
    querySelector: () => codeInput,
  }
  Object.defineProperty(app, "innerHTML", {
    get: () => "",
    set: () => {
      renders += 1
      codeInput = { value: "" }
    },
  })

  const context = {
    sessionStorage: {
      getItem: () => "admin-key",
      setItem: () => {},
      removeItem: () => {},
    },
    document: {
      getElementById: (id: string) => (id === "app" ? app : null),
    },
    fetch: async (url: string) => ({
      status: 200,
      ok: true,
      statusText: "OK",
      json: async () =>
        url.endsWith("/providers")
          ? {
              providers: [
                {
                  id: "anthropic",
                  name: "Claude Pro/Max",
                  kind: "paste",
                  authPath: "/tmp/auth.json",
                  connected: false,
                },
              ],
            }
          : { id: "flow-1", provider: "anthropic", kind: "paste", status: "awaiting_code" },
    }),
    setInterval: (callback: () => Promise<void>) => {
      poll = callback
      return 1
    },
    clearInterval: () => {},
    window: { open: () => {} },
    console,
  }

  vm.runInNewContext(
    script +
      '\nglobalThis.startPolling = () => { flows.anthropic = { id: "flow-1", status: "awaiting_code" }; watch("anthropic"); };',
    context,
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  ;(context as typeof context & { startPolling: () => void }).startPolling()
  assert.ok(poll)

  codeInput.value = "code#state"
  const rendersBeforePoll = renders
  await poll()

  assert.equal(renders, rendersBeforePoll)
  assert.equal(codeInput.value, "code#state")
})
