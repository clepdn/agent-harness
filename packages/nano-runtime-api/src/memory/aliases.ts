/**
 * Memory alias system — handle resolution, loading, and CRUD.
 *
 * @module memory/aliases
 */

import fs from "fs/promises"
import path from "path"
import { type AliasMap, normalizeHandle } from "./shared"
import { atomicWriteFile, isMissingFileError, quarantineFile } from "../durable-file"

export { normalizeHandle }

export interface AliasService {
  listAliases(): Promise<AliasMap>
  loadAliasMap(): Promise<AliasMap>
  setAlias(handle: string, canonical: string): Promise<AliasMap>
  removeAlias(handle: string, canonical?: string): Promise<AliasMap>
  resolveAliases(handle: string | null, map: AliasMap): string[]
}

export function createAliasService({ home }: { home: string }): AliasService {
  const memoriesDir = path.join(home, "memories")
  const aliasesFile = path.join(memoriesDir, "aliases.json")
  let aliasCache: { mtimeMs: number; map: AliasMap } | null = null

  async function loadAliasMap(): Promise<AliasMap> {
    try {
      const stat = await fs.stat(aliasesFile)
      if (aliasCache && aliasCache.mtimeMs === stat.mtimeMs) return aliasCache.map
      const raw = await fs.readFile(aliasesFile, "utf-8")
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new SyntaxError("alias map must be a JSON object")
      }
      const map: AliasMap = {}
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const handle = normalizeHandle(key)
        if (!handle) continue
        const list = Array.isArray(value) ? value : [value]
        const aliases = list
          .map((v) => (typeof v === "string" ? normalizeHandle(v) : ""))
          .filter((v) => v && v !== handle)
        if (aliases.length > 0) map[handle] = Array.from(new Set(aliases))
      }
      aliasCache = { mtimeMs: stat.mtimeMs, map }
      return map
    } catch (error) {
      if (isMissingFileError(error)) {
        aliasCache = { mtimeMs: 0, map: {} }
        return {}
      }
      if (error instanceof SyntaxError) {
        const quarantined = await quarantineFile(aliasesFile).catch(() => null)
        console.warn(`[memory] invalid alias JSON${quarantined ? ` quarantined at ${quarantined}` : ""}: ${error.message}`)
        aliasCache = { mtimeMs: 0, map: {} }
        return {}
      }
      throw error
    }
  }

  async function writeAliasMap(map: AliasMap): Promise<void> {
    await fs.mkdir(memoriesDir, { recursive: true })
    const sorted: AliasMap = {}
    for (const key of Object.keys(map).sort()) sorted[key] = [...map[key]!].sort()
    await atomicWriteFile(aliasesFile, `${JSON.stringify(sorted, null, 2)}\n`)
    aliasCache = null
  }

  async function listAliases(): Promise<AliasMap> {
    return loadAliasMap()
  }

  async function setAlias(handle: string, canonical: string): Promise<AliasMap> {
    const h = normalizeHandle(handle)
    const c = normalizeHandle(canonical)
    if (!h || !c) throw new Error("alias handle and canonical must be non-empty")
    const map = await loadAliasMap()
    if (h === c) return map
    const existing = new Set(map[h] ?? [])
    existing.add(c)
    map[h] = Array.from(existing)
    await writeAliasMap(map)
    return map
  }

  async function removeAlias(handle: string, canonical?: string): Promise<AliasMap> {
    const h = normalizeHandle(handle)
    if (!h) throw new Error("alias handle must be non-empty")
    const map = await loadAliasMap()
    if (!map[h]) return map
    if (canonical) {
      const c = normalizeHandle(canonical)
      map[h] = map[h]!.filter((entry) => entry !== c)
      if (map[h]!.length === 0) delete map[h]
    } else {
      delete map[h]
    }
    await writeAliasMap(map)
    return map
  }

  return { listAliases, loadAliasMap, setAlias, removeAlias, resolveAliases }
}

/**
 * Resolves all transitive aliases for a handle via BFS traversal.
 *
 * @param handle - Starting handle (or `null`).
 * @param map - Alias map to traverse.
 * @returns All reachable alias handles (not including the start).
 */
export function resolveAliases(handle: string | null, map: AliasMap): string[] {
  if (!handle) return []
  const seen = new Set<string>([handle])
  const out: string[] = []
  const queue = [handle]
  while (queue.length > 0) {
    const current = queue.shift()!
    const next = map[current] ?? []
    for (const alias of next) {
      if (seen.has(alias)) continue
      seen.add(alias)
      out.push(alias)
      queue.push(alias)
    }
  }
  return out
}
