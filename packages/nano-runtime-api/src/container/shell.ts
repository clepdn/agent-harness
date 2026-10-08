import * as pty from "node-pty"
import { spawn } from "child_process"
import {
  CONTAINER_NAME,
  CONTAINER_USER,
  DEFAULT_COMMAND_TIMEOUT_MS,
  SSH_IDENTITY,
  SSH_TARGET,
  USE_DOCKER_SHELL,
  USE_SSH,
  normalizeTimeoutMs,
} from "./config"
import type { RunRawOptions } from "./types"

function applyTerminalControls(str: string): string {
  let out = ""

  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i]

    if (ch === "\r") {
      if (str[i + 1] === "\n") {
        out += "\n"
        i += 1
      } else {
        const lineStart = out.lastIndexOf("\n") + 1
        out = out.slice(0, lineStart)
      }
      continue
    }

    if (ch === "\b" || ch === "\x7f") {
      if (out.length > 0 && out[out.length - 1] !== "\n") out = out.slice(0, -1)
      continue
    }

    if (ch === "\x00") continue
    out += ch
  }

  return out
}

/**
 * Strip ANSI/VT escape sequences and apply simple terminal line controls.
 * PTYs emit redraw-oriented output (CR, backspace, ANSI cursor commands) that
 * should not be preserved as literal command result text.
 */
export function cleanOutput(str: string): string {
  const withoutEscapes = str
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI sequences (colors, cursor, erase, etc.)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences (title, etc.)
    .replace(/\x1b[^[\]]/g, "") // other 2-char ESC sequences
    .replace(/(?:\x03|\^C)\s*/g, "") // Ctrl+C echo after interrupt

  return applyTerminalControls(withoutEscapes)
}

// ── Fixed working directory ───────────────────────────────────────────────────

/**
 * Every command starts from this directory — no persistence between calls.
 */
const ROOT_CWD = USE_DOCKER_SHELL ? `/home/${CONTAINER_USER}` : USE_SSH ? "~" : process.cwd()

function sshArgs(): string[] {
  return SSH_IDENTITY ? ["-i", SSH_IDENTITY] : []
}

/**
 * Opens a shell session.  No-op — every command runs in its own
 * fresh PTY so there is no persistent session to open.
 */
export async function openBash(): Promise<void> {
  // No-op: sessions are not reused.
}

/**
 * Closes the shell session.  No-op — there is no persistent session.
 */
export function closeBash(): void {
  // No-op: sessions are not reused.
}

/**
 * Returns the fixed root working directory.  `cd` in one command does not
 * affect the starting directory of the next — there is no state.
 */
export async function currentWorkingDirectory(_timeoutMs?: number): Promise<string> {
  return ROOT_CWD
}

// ── PTY helpers ───────────────────────────────────────────────────────────────

function ptyEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    PAGER: "cat",
    LESS: "FRX",
  }
}

function ptyOptions() {
  return {
    name: "xterm-256color",
    cols: 220,
    rows: 50,
    env: ptyEnv(),
  }
}

/**
 * Spawn a one-shot PTY that runs the given bash command and exits.
 */
function spawnOneShot(command: string): pty.IPty {
  if (USE_DOCKER_SHELL) {
    return pty.spawn(
      "docker",
      ["exec", "-i", "-u", CONTAINER_USER, "-w", ROOT_CWD, CONTAINER_NAME, "bash", "-c", command],
      ptyOptions(),
    )
  }

  if (USE_SSH) {
    return pty.spawn("ssh", [...sshArgs(), SSH_TARGET, "bash", "-c", command], ptyOptions())
  }

  return pty.spawn("bash", ["-c", command], {
    ...ptyOptions(),
    cwd: ROOT_CWD,
  })
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Runs a command in a fresh PTY session and returns cleaned output.
 *
 * Each invocation spawns a new `bash -c` PTY — sessions are never reused.
 * Every command starts from the fixed root directory regardless of any
 * previous `cd` calls.
 *
 * @param command - Raw shell command to execute.
 * @param options - Timeout and stdin-redirection behavior.
 * @returns Combined stdout/stderr output with PTY control noise removed.
 * @throws If command execution times out.
 */
export async function runRaw(command: string, options: RunRawOptions = {}): Promise<string> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS)
  const redirectStdinToDevNull = options.redirectStdinToDevNull ?? false

  // Wrap command in a { } group. When requested, redirect stdin from
  // /dev/null so accidental interactive reads do not hang forever.
  // The closing } is on its own line so heredocs inside the command still
  // get their correct delimiter line.
  const fullCommand = redirectStdinToDevNull ? `{ ${command}\n} < /dev/null` : `{ ${command}\n}`

  return new Promise((resolve, reject) => {
    let raw = ""
    let settled = false

    const proc = spawnOneShot(fullCommand)

    proc.onData((chunk: string) => {
      raw += chunk
    })

    proc.onExit(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(cleanOutput(raw).trimEnd())
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill()
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`))
    }, timeoutMs)
  })
}

/**
 * Runs a command as a one-off child process instead of through a PTY.
 * Used for commands that should not inherit interactive stdin, notably sudo.
 */
export async function runOneOff(command: string, cwd: string, options: RunRawOptions = {}): Promise<string> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS)

  const args = USE_DOCKER_SHELL
    ? ["exec", "-i", "-u", CONTAINER_USER, "-w", cwd, CONTAINER_NAME, "bash", "-c", command]
    : USE_SSH
    ? [...sshArgs(), SSH_TARGET, "bash", "-c", `cd ${JSON.stringify(cwd)} && { ${command}\n}`]
    : ["-c", command]
  const program = USE_DOCKER_SHELL ? "docker" : USE_SSH ? "ssh" : "bash"

  return new Promise((resolve, reject) => {
    let raw = ""
    let settled = false
    const child = spawn(program, args, {
      cwd: (USE_DOCKER_SHELL || USE_SSH) ? undefined : cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    child.stdout.on("data", (chunk) => {
      raw += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk) => {
      raw += chunk.toString("utf8")
    })
    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on("close", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(cleanOutput(raw).trimEnd())
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`))
    }, timeoutMs)
  })
}
