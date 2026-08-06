/**
 * The house TOML dialect: comments, [tables], nested [a.b] tables, [[arrays of
 * tables]], basic and literal strings, integers, floats, booleans, and
 * single-line arrays of scalars.
 *
 * Deliberately small. Both configuration surfaces — the runtime's
 * `--config`/`--secrets` files and the control plane's `agents/*.toml` — parse
 * with this one implementation so they cannot drift apart. Keys are literal:
 * write nested values as tables, not dotted keys.
 */

export type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue }
export type TomlTable = Record<string, TomlValue>

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {}
  let cursor: TomlTable = root

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim()
    if (!line) continue

    // Array-of-tables header: [[key]] or [[a.b]]
    // Each occurrence creates a fresh table and appends it to an array.
    if (line.startsWith("[[") && line.endsWith("]]")) {
      const path = line.slice(2, -2).trim()
      if (!path) throw new Error("empty array-of-tables header")
      cursor = root
      const segments = path.split(".")
      for (let i = 0; i < segments.length; i++) {
        const key = segments[i]!.trim()
        const isLast = i === segments.length - 1
        const existing = cursor[key]
        if (isLast) {
          // Create or append to the array of tables
          if (existing === undefined) {
            cursor[key] = []
          } else if (!Array.isArray(existing)) {
            throw new Error(`table path "${path}" overlaps a non-array value at "${key}"`)
          }
          const arr = cursor[key] as TomlValue[]
          const fresh: TomlTable = {}
          arr.push(fresh)
          cursor = fresh
        } else {
          // Navigate through intermediate keys
          if (existing === undefined) {
            const fresh: TomlTable = {}
            cursor[key] = fresh
            cursor = fresh
          } else if (isTable(existing)) {
            cursor = existing
          } else if (Array.isArray(existing)) {
            // Use the last element of an existing array-of-tables
            const last = existing[existing.length - 1]
            if (!isTable(last)) throw new Error(`cannot navigate into non-table array element at "${key}"`)
            cursor = last
          } else {
            throw new Error(`table path "${path}" overlaps a non-table value at "${key}"`)
          }
        }
      }
      continue
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      const path = line.slice(1, -1).trim()
      if (!path) throw new Error("empty table header")
      cursor = root
      for (const segment of path.split(".")) {
        const key = segment.trim()
        const next = cursor[key]
        if (next === undefined) {
          const fresh: TomlTable = {}
          cursor[key] = fresh
          cursor = fresh
        } else if (isTable(next)) {
          cursor = next
        } else {
          throw new Error(`table path "${path}" overlaps a non-table value`)
        }
      }
      continue
    }

    const eq = line.indexOf("=")
    if (eq <= 0) throw new Error(`invalid TOML line: ${raw}`)
    const key = line.slice(0, eq).trim()
    cursor[key] = parseValue(line.slice(eq + 1).trim())
  }
  return root
}

function stripComment(line: string): string {
  let inString = false
  let quote = ""
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inString) {
      if (c === "\\") { i++; continue }
      if (c === quote) inString = false
    } else if (c === '"' || c === "'") {
      inString = true
      quote = c
    } else if (c === "#") {
      return line.slice(0, i)
    }
  }
  return line
}

function parseValue(text: string): TomlValue {
  if (!text) throw new Error("missing TOML value")
  if (text.startsWith('"') && text.endsWith('"')) return JSON.parse(text) as string
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1)
  if (text === "true") return true
  if (text === "false") return false
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim()
    if (!inner) return []
    return splitArrayItems(inner).map(parseValue)
  }
  const num = Number(text)
  if (Number.isFinite(num)) return num
  throw new Error(`could not parse TOML value: ${text}`)
}

function splitArrayItems(text: string): string[] {
  const items: string[] = []
  let depth = 0
  let inString = false
  let quote = ""
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === "\\") { i++; continue }
      if (c === quote) inString = false
    } else if (c === '"' || c === "'") {
      inString = true
      quote = c
    } else if (c === "[") depth++
    else if (c === "]") depth--
    else if (c === "," && depth === 0) {
      items.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  const last = text.slice(start).trim()
  if (last) items.push(last)
  return items
}

export function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function deepMerge(base: TomlTable, overlay: TomlTable): TomlTable {
  const out: TomlTable = { ...base }
  for (const [k, v] of Object.entries(overlay)) {
    const baseValue = out[k]
    out[k] = isTable(baseValue) && isTable(v) ? deepMerge(baseValue, v) : v
  }
  return out
}
