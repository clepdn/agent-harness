/**
 * Computer use tools — modeled after OpenAI's computer_use_preview action types.
 * Uses xdotool for input simulation and ImageMagick `import` for screenshots.
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

import path from "path"
import { runCommand, readImageForModel } from "../container/index"
import { config } from "../config"

// ── Key normalization ─────────────────────────────────────────────────────────

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

function normalizeKey(key: string): string {
  const upper = key.toUpperCase()
  return KEY_MAP[upper] ?? key
}

/** Convert an array of key names to an xdotool key combo string. */
function keyCombo(keys: string[]): string {
  return keys.map(normalizeKey).join("+")
}

// ── Button mapping ───────────────────────────────────────────────────────────

const BUTTON_MAP: Record<string, number> = {
  left: 1,
  middle: 2,
  right: 3,
}

function buttonCode(button?: string): number {
  return BUTTON_MAP[(button ?? "left").toLowerCase()] ?? 1
}

// ── Display env ──────────────────────────────────────────────────────────────

function displayEnv(): string {
  const d = config.computer_use?.display ?? process.env.DISPLAY ?? ":0"
  return `DISPLAY=${d}`
}

// ── Action execution ─────────────────────────────────────────────────────────

export interface ComputerAction {
  action: string
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

export interface ComputerResult {
  output: string
  image?: { dataUrl: string; mime: string; path: string; bytes: number }
}

/** Execute a computer use action. Returns text output and optionally a screenshot. */
export async function executeAction(act: ComputerAction): Promise<ComputerResult> {
  const display = displayEnv()

  switch (act.action) {
    case "screenshot": {
      const imgPath = path.join("/tmp", `screenshot-${Date.now()}.png`)
      await runCommand(
        `export ${display} && import -window root "${imgPath}"`,
        0,
        30000,
      )
      const image = await readImageForModel(imgPath, 30000)
      return { output: `screenshot captured (${image.bytes} bytes)`, image }
    }

    case "click": {
      const btn = buttonCode(act.button)
      const mods = act.keys?.length ? `+${act.keys.map(normalizeKey).join("+")}` : ""
      await runCommand(
        `export ${display} && xdotool mousemove ${act.x} ${act.y} click${mods ? ` --window $(xdotool getwindowfocus)` : ""} ${btn}`,
        0,
        10000,
      )
      return { output: `clicked ${act.button ?? "left"} at (${act.x}, ${act.y})` }
    }

    case "double_click": {
      const btn = buttonCode(act.button)
      await runCommand(
        `export ${display} && xdotool mousemove ${act.x} ${act.y} click --repeat 2 ${btn}`,
        0,
        10000,
      )
      return { output: `double-clicked ${act.button ?? "left"} at (${act.x}, ${act.y})` }
    }

    case "scroll": {
      const btn = (act.scroll_y ?? 0) < 0 ? 4 : 5
      const clicks = Math.max(1, Math.abs(Math.round((act.scroll_y ?? 0) / 100)))
      await runCommand(
        `export ${display} && xdotool mousemove ${act.x} ${act.y}`,
        0,
        10000,
      )
      for (let i = 0; i < clicks; i++) {
        await runCommand(`export ${display} && xdotool click ${btn}`, 0, 5000)
      }
      return { output: `scrolled ${clicks} clicks ${btn === 4 ? "up" : "down"} at (${act.x}, ${act.y})` }
    }

    case "type": {
      const text = act.text ?? ""
      // Use --clearmodifiers to avoid stuck modifier keys
      await runCommand(
        `export ${display} && xdotool type --clearmodifiers --delay 0 '${text.replace(/'/g, "'\\''")}'`,
        0,
        30000,
      )
      return { output: `typed ${text.length} chars` }
    }

    case "keypress": {
      const keys = act.keys ?? []
      if (keys.length === 0) throw new Error("keypress requires at least one key")
      const combo = keyCombo(keys)
      await runCommand(
        `export ${display} && xdotool key '${combo}'`,
        0,
        10000,
      )
      return { output: `pressed ${combo}` }
    }

    case "drag": {
      const path = act.path ?? []
      if (path.length < 2) throw new Error("drag requires at least two path points")
      const [[startX, startY], ...rest] = path
      await runCommand(
        `export ${display} && xdotool mousemove ${startX} ${startY} mousedown 1`,
        0,
        10000,
      )
      for (const [x, y] of rest) {
        await runCommand(`export ${display} && xdotool mousemove ${x} ${y}`, 0, 5000)
      }
      await runCommand(`export ${display} && xdotool mouseup 1`, 0, 5000)
      return { output: `dragged from (${startX}, ${startY}) through ${rest.length} points` }
    }

    case "move": {
      await runCommand(
        `export ${display} && xdotool mousemove ${act.x} ${act.y}`,
        0,
        10000,
      )
      return { output: `moved mouse to (${act.x}, ${act.y})` }
    }

    case "wait": {
      const ms = act.duration ?? 1000
      await new Promise((r) => setTimeout(r, ms))
      return { output: `waited ${ms}ms` }
    }

    default:
      throw new Error(`unsupported computer action: ${act.action}`)
  }
}
