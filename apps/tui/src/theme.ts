// Minimal ANSI styling helpers — no dependencies, Claude-Code-ish palette.
const ESC = "\u001b["
const on = process.stdout.isTTY

const wrap = (open: string, close: string) => (s: string): string =>
  on ? `${ESC}${open}m${s}${ESC}${close}m` : s

export const dim = wrap("2", "22")
export const bold = wrap("1", "22")
export const italic = wrap("3", "23")
export const red = wrap("31", "39")
export const green = wrap("32", "39")
export const yellow = wrap("33", "39")
export const blue = wrap("34", "39")
export const magenta = wrap("35", "39")
export const cyan = wrap("36", "39")
export const gray = wrap("90", "39")

export const HIDE_CURSOR = on ? `${ESC}?25l` : ""
export const SHOW_CURSOR = on ? `${ESC}?25h` : ""

/** Clear the current line and return carriage. */
export const clearLine = on ? `\r${ESC}2K` : "\r"
