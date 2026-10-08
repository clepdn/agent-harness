import http from "node:http"
import type { AddressInfo } from "node:net"

export interface PrometheusScrapeSource {
  render(): string
}

export interface PrometheusExporter {
  start(): Promise<void>
  close(): Promise<void>
  address(): AddressInfo | string | null
}

export function createPrometheusExporter(registry: PrometheusScrapeSource, port = 9100, host = "127.0.0.1"): PrometheusExporter {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError("Prometheus port must be an integer from 0 to 65535")
  let server: http.Server | undefined
  let startPromise: Promise<void> | undefined
  let closePromise: Promise<void> | undefined

  const start = (): Promise<void> => {
    if (startPromise) return startPromise
    if (server?.listening) return Promise.resolve()
    if (closePromise) return closePromise.then(start)

    const current = http.createServer((req, res) => {
      if (req.url === "/metrics") {
        try {
          res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" })
          res.end(registry.render())
        } catch (error) {
          if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" })
          res.end(`metrics render failed: ${error instanceof Error ? error.message : String(error)}\n`)
        }
        return
      }
      if (req.url === "/" || req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" })
        res.end("nano prometheus exporter\n")
        return
      }
      res.writeHead(404, { "Content-Type": "text/plain" })
      res.end("not found\n")
    })
    server = current
    startPromise = new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        current.off("listening", onListening)
        if (server === current) server = undefined
        startPromise = undefined
        reject(error)
      }
      const onListening = (): void => {
        current.off("error", onError)
        startPromise = undefined
        resolve()
      }
      current.once("error", onError)
      current.once("listening", onListening)
      current.listen(port, host)
    })
    return startPromise
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    const waitForStart = startPromise?.catch(() => {}) ?? Promise.resolve()
    closePromise = waitForStart.then(() => {
      const current = server
      server = undefined
      if (!current || !current.listening) return
      return new Promise<void>((resolve, reject) => {
        current.close((error) => error ? reject(error) : resolve())
      })
    }).finally(() => {
      closePromise = undefined
    })
    return closePromise
  }

  return {
    start,
    close,
    address() {
      return server?.address() ?? null
    },
  }
}
