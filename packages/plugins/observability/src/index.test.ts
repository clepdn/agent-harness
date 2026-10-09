import assert from "node:assert/strict"
import net from "node:net"
import test from "node:test"
import { CordisContext } from "@nano/plugins"
import { nano } from "@nano/runtime-api"
import type { MetricsService } from "@nano/runtime-api"
import { createObservabilityPlugin } from "./index"

test("an occupied Prometheus port does not abort plugin startup", async (t) => {
  const blocker = net.createServer()
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject)
    blocker.listen(0, "127.0.0.1", resolve)
  })
  const address = blocker.address()
  assert.ok(address && typeof address !== "string")

  const ctx = new CordisContext()
  t.after(async () => {
    await ctx.fiber.dispose()
    await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()))
  })
  const errors: unknown[][] = []
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args) })
  await ctx.plugin({
    name: "test.metrics",
    apply(serviceCtx) {
      serviceCtx.provide(nano.metrics.name, { renderPrometheus: () => "# test\n" } as unknown as MetricsService)
    },
  })

  await ctx.plugin(createObservabilityPlugin({ port: address.port, host: "127.0.0.1" }), {})

  assert.equal(errors.length, 1)
  assert.match(errors[0]!.map(String).join(" "), /prometheus.*EADDRINUSE/i)
})
