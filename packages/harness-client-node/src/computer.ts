/**
 * Computer use — modeled after OpenAI's computer_use_preview action types.
 * Uses xdotool for input simulation and ImageMagick `import` for screenshots.
 *
 * This runs wherever the client host runs, so the X display it drives is the
 * executor's, not the control plane's.
 *
 * Action types:
 *   screenshot     — capture the screen, return as image
 *   click          — click at (x, y) with optional button + modifier keys
 *   double_click   — double-click at (x, y)
 *   scroll         — scroll at (x, y) by (scroll_x, scroll_y) amounts
 *   type           — type a text string
 *   keypress       — press a key combination (e.g. ["CTRL", "c"])
 *   drag           — drag along a path of [x, y] points
 *   move           — move mouse to (x, y) without clicking
 *   wait           — wait for a duration (ms)
 */

import fs from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { ClientImageArtifact } from "@nano/harness-protocol"
import { IMAGE_ROOT } from "./config.js"
import { readImageForModel, runCommand } from "./tools.js"

/** Map model-emitted key names to xdotool key names. */
const KEY_MAP: Record<string, string> = {
  ENTER: "Return",
  RETURN: "Return",
  ESC: "Escape",
  ESCAPE: "Escape",
  TAB: "Tab",
  SPACE: "space",
  BACKSPACE: "BackSpace",
  DELETE: "Delete",
  DEL: "Delete",
  HOME: "Home",
  END: "End",
  PAGEUP: "Page_Up",
  PAGEDOWN: "Page_Down",
  UP: "Up",
  ARROWUP: "Up",
  DOWN: "Down",
  ARROWDOWN: "Down",
  LEFT: "Left",
  ARROWLEFT: "Left",
  RIGHT: "Right",
  ARROWRIGHT: "Right",
  CTRL: "ctrl",
  CONTROL: "ctrl",
  SHIFT: "shift",
  OPTION: "alt",
  ALT: "alt",
  META: "super",
  CMD: "super",
  COMMAND: "super",
  SUPER: "super",
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",
}

const BUTTON_MAP: Record<string, number> = { left: 1, middle: 2, right: 3 }

/**
 * xdotool and `import` normally say nothing on success. Non-zero exits are
 * rejected by the shell runner; unexpected successful output is also treated
 * as a failure so display diagnostics cannot be mistaken for success.
 */
async function xdo(command: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const output = (await runCommand(command, 0, timeoutMs, false, signal)).trim()
  if (output) throw new Error(output.split("\n").slice(0, 3).join(" | "))
}

function normalizeKey(key: string): string {
  return KEY_MAP[key.toUpperCase()] ?? key
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function coordinate(value: unknown, name: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`)
  return Math.trunc(n)
}

export type ComputerAction = {
  action: string
  display?: string
  x?: number
  y?: number
  button?: string
  text?: string
  keys?: string[]
  scroll_x?: number
  scroll_y?: number
  path?: Array<[number, number]>
  duration?: number
}

export function parseComputerAction(args: Record<string, unknown>): ComputerAction {
  return {
    action: String(args.action ?? "").trim(),
    ...(typeof args.display === "string" ? { display: args.display } : {}),
    ...(args.x !== undefined ? { x: coordinate(args.x, "x") } : {}),
    ...(args.y !== undefined ? { y: coordinate(args.y, "y") } : {}),
    ...(typeof args.button === "string" ? { button: args.button } : {}),
    ...(args.text !== undefined ? { text: String(args.text) } : {}),
    ...(Array.isArray(args.keys) ? { keys: args.keys.map((key) => String(key)) } : {}),
    ...(args.scroll_x !== undefined ? { scroll_x: Number(args.scroll_x) } : {}),
    ...(args.scroll_y !== undefined ? { scroll_y: Number(args.scroll_y) } : {}),
    ...(Array.isArray(args.path)
      ? {
          path: args.path.map((point) => {
            if (!Array.isArray(point) || point.length < 2) throw new Error("path points must be [x, y] pairs")
            return [coordinate(point[0], "path x"), coordinate(point[1], "path y")] as [number, number]
          }),
        }
      : {}),
    ...(args.duration !== undefined ? { duration: Number(args.duration) } : {}),
  }
}

/**
 * Execute a computer action. Screenshots come back as an image artifact; every
 * other action returns a one-line description of what it did.
 */
export async function executeComputerAction(
  act: ComputerAction,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<string | ClientImageArtifact> {
  const display = `DISPLAY=${quote(act.display?.trim() || process.env.DISPLAY || ":0")}`

  switch (act.action) {
    case "screenshot": {
      // readImageForModel only serves paths inside IMAGE_ROOT, so capture there.
      await fs.mkdir(IMAGE_ROOT, { recursive: true })
      const imgPath = path.join(IMAGE_ROOT, `screenshot-${Date.now()}.png`)
      await xdo(`export ${display} && import -window root ${quote(imgPath)}`, Math.min(30_000, timeoutMs), signal)
      return readImageForModel(imgPath, Math.min(30_000, timeoutMs))
    }

    case "click": {
      const btn = BUTTON_MAP[(act.button ?? "left").toLowerCase()] ?? 1
      const mods = act.keys?.length ? `+${act.keys.map(normalizeKey).join("+")}` : ""
      await xdo(`export ${display} && xdotool mousemove ${act.x} ${act.y} click${mods ? ` --window $(xdotool getwindowfocus)` : ""} ${btn}`, Math.min(10_000, timeoutMs), signal)
      return `clicked ${act.button ?? "left"} at (${act.x}, ${act.y})`
    }

    case "double_click": {
      const btn = BUTTON_MAP[(act.button ?? "left").toLowerCase()] ?? 1
      await xdo(`export ${display} && xdotool mousemove ${act.x} ${act.y} click --repeat 2 ${btn}`, Math.min(10_000, timeoutMs), signal)
      return `double-clicked ${act.button ?? "left"} at (${act.x}, ${act.y})`
    }

    case "scroll": {
      const btn = (act.scroll_y ?? 0) < 0 ? 4 : 5
      const clicks = Math.max(1, Math.abs(Math.round((act.scroll_y ?? 0) / 100)))
      await xdo(`export ${display} && xdotool mousemove ${act.x} ${act.y}`, Math.min(10_000, timeoutMs), signal)
      for (let i = 0; i < clicks; i++) {
        await xdo(`export ${display} && xdotool click ${btn}`, Math.min(5_000, timeoutMs), signal)
      }
      return `scrolled ${clicks} clicks ${btn === 4 ? "up" : "down"} at (${act.x}, ${act.y})`
    }

    case "type": {
      const text = act.text ?? ""
      // --clearmodifiers avoids stuck modifier keys.
      await xdo(`export ${display} && xdotool type --clearmodifiers --delay 0 ${quote(text)}`, Math.min(30_000, timeoutMs), signal)
      return `typed ${text.length} chars`
    }

    case "keypress": {
      const keys = act.keys ?? []
      if (keys.length === 0) throw new Error("keypress requires at least one key")
      const combo = keys.map(normalizeKey).join("+")
      await xdo(`export ${display} && xdotool key ${quote(combo)}`, Math.min(10_000, timeoutMs), signal)
      return `pressed ${combo}`
    }

    case "drag": {
      const points = act.path ?? []
      const start = points[0]
      if (!start || points.length < 2) throw new Error("drag requires at least two path points")
      const rest = points.slice(1)
      await xdo(`export ${display} && xdotool mousemove ${start[0]} ${start[1]} mousedown 1`, Math.min(10_000, timeoutMs), signal)
      for (const [x, y] of rest) {
        await xdo(`export ${display} && xdotool mousemove ${x} ${y}`, Math.min(5_000, timeoutMs), signal)
      }
      await xdo(`export ${display} && xdotool mouseup 1`, Math.min(5_000, timeoutMs), signal)
      return `dragged from (${start[0]}, ${start[1]}) through ${rest.length} points`
    }

    case "move": {
      await xdo(`export ${display} && xdotool mousemove ${act.x} ${act.y}`, Math.min(10_000, timeoutMs), signal)
      return `moved mouse to (${act.x}, ${act.y})`
    }

    case "wait": {
      const ms = Number.isFinite(act.duration) ? Math.max(0, Number(act.duration)) : 1000
      const waitedMs = Math.min(ms, timeoutMs)
      await sleep(waitedMs, undefined, { signal })
      return `waited ${waitedMs}ms`
    }

    default:
      throw new Error(`unsupported computer action: ${act.action}`)
  }
}
