import { spawn, type ChildProcess } from "node:child_process"
import * as pty from "node-pty"
import {
  CLIENT_WORKSPACE_ROOT,
  CONTAINER_NAME,
  CONTAINER_USER,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_RESULT_BYTES,
  SHELL_ENV,
  USE_DOCKER_SHELL,
  normalizeTimeoutMs,
} from "./config.js"
import type { RunRawOptions } from "./types.js"

function applyTerminalControls(str: string): string {
  let out = ""
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i]
    if (ch === "\r") {
      if (str[i + 1] === "\n") {
        out += "\n"
        i += 1
      } else {
        out = out.slice(0, out.lastIndexOf("\n") + 1)
      }
      continue
    }
    if (ch === "\b" || ch === "\x7f") {
      if (out.length > 0 && out[out.length - 1] !== "\n") out = out.slice(0, -1)
      continue
    }
    if (ch !== "\x00") out += ch
  }
  return out
}

/** Strip ANSI/VT escape sequences and apply simple terminal line controls. */
export function cleanOutput(str: string): string {
  return applyTerminalControls(
    str
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b[^[\]]/g, "")
      .replace(/(?:\x03|\^C)\s*/g, ""),
  )
}

function captureLimitBytes(): number {
  return Math.max(1_000_000, MAX_RESULT_BYTES * 2)
}

function commandEnvironment(): Record<string, string> {
  return {
    ...SHELL_ENV,
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    PAGER: "cat",
    LESS: "FRX",
  }
}

function commandArgs(command: string, usePty: boolean): { program: string; args: string[] } {
  if (USE_DOCKER_SHELL) {
    return {
      program: "docker",
      args: [
        "exec", usePty ? "-it" : "-i",
        "-u", CONTAINER_USER,
        "-w", CLIENT_WORKSPACE_ROOT,
        CONTAINER_NAME,
        "bash", "--noprofile", "--norc", "-c", command,
      ],
    }
  }
  return { program: "bash", args: ["--noprofile", "--norc", "-c", command] }
}

function failure(command: string, output: string, detail: string): Error {
  return new Error(`Command ${detail}: ${command}${output ? `\n${output}` : ""}`)
}

function abortError(command: string, signal: AbortSignal): Error {
  const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "cancelled")
  return new Error(`Command cancelled (${reason}): ${command}`)
}

function killChild(child: ChildProcess): void {
  let groupSignalled = false
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, "SIGTERM")
      groupSignalled = true
    }
  } catch {
    // The process group may already be gone.
  }
  if (!groupSignalled && child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGTERM") } catch {}
  }
  const forceTimer = setTimeout(() => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL")
      else if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    } catch {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL") } catch {}
      }
    }
  }, 500)
  forceTimer.unref?.()
}

function terminateRemainingChildren(child: ChildProcess): void {
  if (process.platform === "win32" || !child.pid) return
  try { process.kill(-child.pid, "SIGTERM") } catch {}
}

function runProcess(command: string, cwd: string, options: RunRawOptions): Promise<string> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS)
  // Route combined output through a short-lived cat process. Besides preserving
  // stdout/stderr ordering, this ensures runtimes that buffer when their pipe is
  // owned directly by the daemon (notably Node) flush before Bash exits.
  // pipefail retains the command group's non-zero status.
  const wrappedCommand = `set -o pipefail\n{ ${command}\n} 2>&1 | cat`
  const { program, args } = commandArgs(wrappedCommand, false)
  return new Promise((resolve, reject) => {
    let raw = ""
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const child = spawn(program, args, {
      cwd: USE_DOCKER_SHELL ? undefined : cwd,
      env: commandEnvironment(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
    }
    const rejectAndKill = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      child.stdout.removeAllListeners("data")
      child.stderr.removeAllListeners("data")
      killChild(child)
      reject(error)
    }
    const append = (chunk: Buffer): void => {
      if (settled) return
      raw += chunk.toString("utf8")
      if (Buffer.byteLength(raw, "utf8") > captureLimitBytes()) {
        rejectAndKill(new Error(`command output exceeded ${captureLimitBytes()} bytes`))
      }
    }
    const onAbort = (): void => rejectAndKill(abortError(command, options.signal!))
    child.stdout.on("data", append)
    child.stderr.on("data", append)
    child.once("error", (error) => rejectAndKill(error))
    child.once("close", (code, signal) => {
      if (settled) return
      settled = true
      cleanup()
      terminateRemainingChildren(child)
      const output = cleanOutput(raw).trimEnd()
      if (code === 0) resolve(output)
      else if (signal) reject(failure(command, output, `terminated by ${signal}`))
      else reject(failure(command, output, `exited with code ${code ?? "unknown"}`))
    })
    if (options.signal?.aborted) {
      onAbort()
      return
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(
      () => rejectAndKill(failure(command, cleanOutput(raw).trimEnd(), `timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    timer.unref?.()
  })
}

function runPty(command: string, cwd: string, options: RunRawOptions): Promise<string> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS)
  const { program, args } = commandArgs(command, true)
  return new Promise((resolve, reject) => {
    let raw = ""
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let proc: pty.IPty
    let dataDisposable: { dispose(): void } | undefined
    let exitDisposable: { dispose(): void } | undefined
    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      dataDisposable?.dispose()
      exitDisposable?.dispose()
    }
    const rejectAndKill = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      try { proc.kill("SIGKILL") } catch {}
      reject(error)
    }
    const onAbort = (): void => rejectAndKill(abortError(command, options.signal!))
    try {
      proc = pty.spawn(program, args, {
        name: "xterm-256color",
        cols: 220,
        rows: 50,
        cwd: USE_DOCKER_SHELL ? process.cwd() : cwd,
        env: commandEnvironment(),
      })
    } catch (error) {
      reject(error)
      return
    }
    dataDisposable = proc.onData((chunk) => {
      if (settled) return
      raw += chunk
      if (Buffer.byteLength(raw, "utf8") > captureLimitBytes()) {
        rejectAndKill(new Error(`command output exceeded ${captureLimitBytes()} bytes`))
      }
    })
    exitDisposable = proc.onExit(({ exitCode, signal }) => {
      if (settled) return
      settled = true
      cleanup()
      if (process.platform !== "win32") {
        try { process.kill(-proc.pid, "SIGTERM") } catch {}
      }
      const output = cleanOutput(raw).trimEnd()
      if (exitCode === 0) resolve(output)
      else if (signal) reject(failure(command, output, `terminated by signal ${signal}`))
      else reject(failure(command, output, `exited with code ${exitCode}`))
    })
    if (options.signal?.aborted) {
      onAbort()
      return
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(
      () => rejectAndKill(failure(command, cleanOutput(raw).trimEnd(), `timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    timer.unref?.()
  })
}

/** Stateless commands always begin in the configured workspace root. */
export async function currentWorkingDirectory(_timeoutMs?: number): Promise<string> {
  return CLIENT_WORKSPACE_ROOT
}

/** Execute a command in a fresh Bash process, optionally backed by a fresh PTY. */
export async function runRaw(command: string, options: RunRawOptions = {}): Promise<string> {
  return options.pty ? runPty(command, CLIENT_WORKSPACE_ROOT, options) : runProcess(command, CLIENT_WORKSPACE_ROOT, options)
}
