import fs from "node:fs"
import { deepMerge, isConfigObject, parseConfig, type ConfigObject } from "@nano/config"

export type ControlServerOptions = {
  host: string
  port: number
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index >= 0) return argv[index + 1]
  return argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1)
}

function configPaths(argv: string[], env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === "--config" || value === "-c") {
      const next = argv[++index]
      if (next) paths.push(next)
    } else if (value?.startsWith("--config=")) {
      paths.push(value.slice("--config=".length))
    }
  }
  return paths.length > 0 ? paths : (env.NANO_CONFIG ? [env.NANO_CONFIG] : [])
}

function loadConfig(paths: string[]): ConfigObject {
  return paths.reduce<ConfigObject>((config, path) => {
    try {
      return deepMerge(config, parseConfig(fs.readFileSync(path, "utf8")))
    } catch (error) {
      throw new Error(`failed to load config ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, {})
}

/** Resolve control-plane network settings. CLI flags override the server config. */
export function controlServerOptions(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): ControlServerOptions {
  const config = loadConfig(configPaths(argv, env))
  const server = isConfigObject(config.server) ? config.server : {}
  const configuredHost = typeof server.listen === "string" ? server.listen.trim() : ""
  const host = flag(argv, "--host")?.trim() || configuredHost || "127.0.0.1"
  const rawPort = flag(argv, "--port") ?? server.port ?? 3000
  const port = typeof rawPort === "number" ? rawPort : Number.parseInt(String(rawPort), 10)

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid control port: ${rawPort}`)
  }
  return { host, port }
}
