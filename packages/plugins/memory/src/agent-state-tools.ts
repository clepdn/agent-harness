import { createHash, randomUUID } from "node:crypto"
import { constants, type Dirent, type Stats } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { applyHashlineEdits, computeLineHash, resolveEditAnchors, type HashlineToolEdit } from "@nano/harness-client-node"
import { isTrackedStatePath } from "@nano/plugin-persistence/state-history"

import type { AgentStateDependencies, AgentStateService, MemoryAccessOptions } from "@nano/runtime-api/contracts/memory"
export type { AgentStateDependencies, AgentStateService, MemoryAccessOptions } from "@nano/runtime-api/contracts/memory"

const MAX_STATE_WRITE_BYTES = 256_000

export function createAgentStateService(dependencies: AgentStateDependencies): AgentStateService {
  const { home } = dependencies
  const MEMORY_ROOT = path.join(home, "memories")
  const SKILLS_ROOT = path.join(MEMORY_ROOT, "skills")
  const frontendSoulViewPath = path.join(home, ".nano", "frontend-soul", "soul.md")

function isSkillMemoryPath(filePath: string): boolean {
  const relative = path.relative(MEMORY_ROOT, filePath)
  const first = relative.split(path.sep)[0]?.toLowerCase()
  return first === "skills"
}

function assertMemoryAccess(filePath: string, options?: MemoryAccessOptions): void {
  if (options?.excludeSkills && isSkillMemoryPath(filePath)) {
    throw new Error("skill memories are unavailable to the frontend agent")
  }
  const relative = path.relative(MEMORY_ROOT, filePath)
  if (options?.excludeMainSessionArchives && !relative.includes(path.sep) && /^discarded-.*\.json$/i.test(relative)) {
    throw new Error("main session archives are unavailable to the frontend agent")
  }
}

function memoryVisible(filePath: string, options?: MemoryAccessOptions): boolean {
  if (options?.excludeSkills && isSkillMemoryPath(filePath)) return false
  const relative = path.relative(MEMORY_ROOT, filePath)
  return !(options?.excludeMainSessionArchives && !relative.includes(path.sep) && /^discarded-.*\.json$/i.test(relative))
}

function validateMarkdown(content: string): void {
  const headerMatch = /^#{1,6}[^\s#\r\n]/m.test(content)
  if (headerMatch) {
    throw new Error("Markdown validation failed: headers must have a space after the '#' characters (e.g. '## Header', not '##Header')")
  }
  const codeBlocks = content.match(/```/g)
  if (codeBlocks && codeBlocks.length % 2 !== 0) {
    throw new Error("Markdown validation failed: unclosed code block (odd number of '```' markers)")
  }
}

function validateContent(content: unknown, allowEmpty = false): string {
  if (typeof content !== "string" || (!allowEmpty && !content.trim())) throw new Error("content is required")
  if (Buffer.byteLength(content, "utf8") > MAX_STATE_WRITE_BYTES) {
    throw new Error(`content exceeds ${MAX_STATE_WRITE_BYTES} bytes`)
  }
  validateMarkdown(content)
  return content
}

function memoryPath(relativePath: unknown): string {
  if (typeof relativePath !== "string" || !relativePath.trim()) throw new Error("path is required")
  const raw = relativePath.trim()
  const resource = raw.startsWith("memory://") ? raw.slice("memory://".length) : raw
  if (!resource || resource.includes("?") || resource.includes("#")) {
    throw new Error("memory URI must identify a Markdown file without a query or fragment")
  }
  const normalized = resource.replace(/\\/g, "/")
  if (path.posix.isAbsolute(normalized) || path.posix.extname(normalized).toLowerCase() !== ".md") {
    throw new Error("memory path must be a relative Markdown file")
  }
  const resolved = path.resolve(MEMORY_ROOT, normalized)
  const relative = path.relative(MEMORY_ROOT, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("memory path escapes the agent memory directory")
  return resolved
}

function memoryReadTarget(input: unknown): { filePath: string; displayPath: string; root: string } {
  if (typeof input !== "string" || !input.trim()) throw new Error("path is required")
  const displayPath = input.trim()
  const isUri = displayPath.startsWith("memory://")
  const resource = isUri ? displayPath.slice("memory://".length) : displayPath
  if (resource.includes("?") || resource.includes("#")) {
    throw new Error("memory URI must not contain a query or fragment")
  }

  const normalized = resource.replace(/\\/g, "/").replace(/\/+$/, "")
  if (isUri && normalized === "soul.md") {
    return { filePath: path.join(home, "soul.md"), displayPath, root: home }
  }
  if (!isUri && !normalized) throw new Error("path is required")
  if (normalized && path.posix.isAbsolute(normalized)) {
    throw new Error("memory path must be relative")
  }

  const resolved = normalized ? path.resolve(MEMORY_ROOT, normalized) : MEMORY_ROOT
  const relative = path.relative(MEMORY_ROOT, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("memory path escapes the agent memory directory")
  }
  return { filePath: resolved, displayPath, root: MEMORY_ROOT }
}

async function verifyMemoryReadTarget(filePath: string, root: string): Promise<Stats> {
  let stat: Stats
  try {
    stat = await fs.stat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`memory path does not exist: ${filePath}`)
    }
    throw error
  }

  const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(filePath)])
  const relative = path.relative(realRoot, realTarget)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("memory path resolves outside the agent memory directory")
  }
  return stat
}

async function getWarningForFile(filePath: string): Promise<string> {
  try {
    const stat = await fs.stat(filePath)
    if (stat.size > 200_000) {
      return `\nWarning: File size is currently ${(stat.size / 1024).toFixed(1)} KB, which is close to the 256KB cap. Please consider archiving older entries.`
    }
  } catch {}
  return ""
}

async function replaceFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 })
    await fs.rename(temporary, filePath)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function prepareMemoryFile(filePath: string): Promise<void> {
  await fs.mkdir(MEMORY_ROOT, { recursive: true, mode: 0o700 })
  const rootStat = await fs.lstat(MEMORY_ROOT)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("agent memory root must be a real directory")
  await fs.chmod(MEMORY_ROOT, 0o700)

  const parent = path.dirname(filePath)
  const relativeParent = path.relative(MEMORY_ROOT, parent)
  let current = MEMORY_ROOT
  for (const component of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("memory path contains a non-directory or symbolic link")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await fs.mkdir(current, { mode: 0o700 })
    }
  }

  const [realRoot, realParent] = await Promise.all([fs.realpath(MEMORY_ROOT), fs.realpath(parent)])
  const realRelative = path.relative(realRoot, realParent)
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error("memory path resolves outside the agent memory directory")
  }

  try {
    if ((await fs.lstat(filePath)).isSymbolicLink()) throw new Error("memory file must not be a symbolic link")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

async function syncMemoryAfterWrite(): Promise<void> {
  await dependencies.syncMemoryIndex()
}

type MemoryFsOperation = "create" | "delete" | "move" | "copy" | "ls"

function parseMemoryFsOperation(input: unknown): MemoryFsOperation {
  if (typeof input !== "string" || !["create", "delete", "move", "copy", "ls"].includes(input)) {
    throw new Error("op must be create, delete, move, copy, or ls")
  }
  return input as MemoryFsOperation
}

function memoryFsPath(input: unknown, allowRoot = false): { filePath: string; uri: string } {
  if (typeof input !== "string" || !input.trim()) throw new Error("file_name is required")
  const raw = input.trim()
  if (raw.startsWith("local://")) throw new Error("local:// is allowed only as a copy source")
  const resource = raw.startsWith("memory://") ? raw.slice("memory://".length) : raw
  if (resource.includes("?") || resource.includes("#")) {
    throw new Error("memory filesystem path must identify a resource without a query or fragment")
  }
  const slashNormalized = resource.replace(/\\/g, "/")
  const normalized = slashNormalized.replace(/\/+$/, "")
  if ((!normalized && !allowRoot) || path.posix.isAbsolute(slashNormalized)) {
    throw new Error("memory filesystem path must be relative")
  }
  const filePath = normalized ? path.resolve(MEMORY_ROOT, normalized) : MEMORY_ROOT
  const relative = path.relative(MEMORY_ROOT, filePath)
  if ((!relative && !allowRoot) || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("memory filesystem path escapes the agent memory directory")
  }
  return { filePath, uri: `memory://${relative.split(path.sep).join("/")}` }
}

function localFsPath(input: string): string {
  const raw = input.trim()
  if (!raw.startsWith("local://")) throw new Error("local copy sources must use local://")
  const resource = raw.slice("local://".length)
  if (!resource) throw new Error("local:// source must identify a file")
  return resource
}

async function existingMemoryFsTarget(filePath: string): Promise<Stats> {
  let rootStat: Stats
  try {
    rootStat = await fs.lstat(MEMORY_ROOT)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("memory filesystem resource does not exist")
    throw error
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("agent memory root must be a real directory")
  if (filePath === MEMORY_ROOT) return rootStat

  const parent = path.dirname(filePath)
  let current = MEMORY_ROOT
  for (const component of path.relative(MEMORY_ROOT, parent).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error("memory filesystem resource does not exist")
      throw error
    })
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("memory filesystem path contains a non-directory or symbolic link")
    }
  }

  const targetStat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("memory filesystem resource does not exist")
    throw error
  })
  if (targetStat.isSymbolicLink()) throw new Error("memory filesystem resources must not be symbolic links")
  return targetStat
}

async function requireMissingMemoryFsTarget(filePath: string): Promise<void> {
  try {
    await fs.lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  throw new Error("memory filesystem destination already exists")
}

/** Create, delete, move, copy, or list a server-owned memory filesystem resource. */
async function memoryFs(fileName: unknown, rawOperation: unknown, rawTarget?: unknown, options?: MemoryAccessOptions): Promise<string> {
  const operation = parseMemoryFsOperation(rawOperation)
  const sourceIsLocal = typeof fileName === "string" && fileName.trim().startsWith("local://")
  const targetProvided = rawTarget !== undefined

  if (operation === "ls") {
    if (targetProvided) throw new Error("ls does not accept target")
    if (sourceIsLocal) throw new Error("ls requires a memory-relative directory")
    const target = memoryFsPath(fileName, true)
    assertMemoryAccess(target.filePath, options)
    const stat = await existingMemoryFsTarget(target.filePath)
    if (!stat.isDirectory()) throw new Error("ls requires a directory")
    const entries = await getMemoryDirectoryEntries(target.filePath, options)
    const names = entries.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
    return `${target.uri} is a dir\n${names.length ? names.join("\n") : "(empty directory)"}`
  }

  if (sourceIsLocal && options?.allowLocalCopy === false) throw new Error("local:// copies are unavailable to the frontend agent")

  if (operation === "create") {
    if (sourceIsLocal) throw new Error("create requires a memory-relative file_name")
    if (targetProvided) throw new Error("create does not accept target")
    const target = memoryFsPath(fileName)
    assertMemoryAccess(target.filePath, options)
    await prepareMemoryFile(target.filePath)
    await requireMissingMemoryFsTarget(target.filePath)
    await dependencies.persistence.recordStateRevision(target.filePath, "external")
    if (typeof fileName === "string" && fileName.trim().endsWith("/")) {
      await fs.mkdir(target.filePath, { mode: 0o700 })
    } else {
      await fs.writeFile(target.filePath, Buffer.alloc(0), { flag: "wx", mode: 0o600 })
    }
    await dependencies.persistence.recordStateRevision(target.filePath, "memory_fs:create")
    await syncMemoryAfterWrite()
    return `created ${typeof fileName === "string" && fileName.trim().endsWith("/") ? "directory" : "file"} ${target.uri}`
  }

  if (operation === "delete") {
    if (sourceIsLocal) throw new Error("delete requires a memory-relative file_name")
    if (targetProvided) throw new Error("delete does not accept target")
    const target = memoryFsPath(fileName)
    assertMemoryAccess(target.filePath, options)
    const stat = await existingMemoryFsTarget(target.filePath)
    await dependencies.persistence.recordStateRevision(target.filePath, "external")
    if (stat.isDirectory()) {
      await fs.rmdir(target.filePath)
    } else {
      await fs.unlink(target.filePath)
    }
    await dependencies.persistence.recordStateRevision(target.filePath, "memory_fs:delete")
    await syncMemoryAfterWrite()
    return `deleted ${target.uri}`
  }

  if (typeof rawTarget !== "string" || !rawTarget.trim()) throw new Error(`${operation} requires target`)

  if (operation === "move") {
    if (sourceIsLocal) throw new Error("move requires a memory-relative file_name")
    const source = memoryFsPath(fileName)
    assertMemoryAccess(source.filePath, options)
    await existingMemoryFsTarget(source.filePath)
    const destination = memoryFsPath(rawTarget)
    assertMemoryAccess(destination.filePath, options)
    await prepareMemoryFile(destination.filePath)
    await requireMissingMemoryFsTarget(destination.filePath)
    await dependencies.persistence.recordStateRevision(source.filePath, "external")
    await dependencies.persistence.recordStateRevision(destination.filePath, "external")
    await fs.rename(source.filePath, destination.filePath)
    await dependencies.persistence.recordStateRevision(source.filePath, "memory_fs:move")
    await dependencies.persistence.recordStateRevision(destination.filePath, "memory_fs:move")
    await syncMemoryAfterWrite()
    return `moved ${source.uri} -> ${destination.uri}`
  }

  const destination = memoryFsPath(rawTarget)
  assertMemoryAccess(destination.filePath, options)
  await prepareMemoryFile(destination.filePath)
  await requireMissingMemoryFsTarget(destination.filePath)

  let sourceLabel: string
  let sourceBytes: number
  if (sourceIsLocal) {
    sourceLabel = (fileName as string).trim()
    const source = await dependencies.readClientFile(localFsPath(sourceLabel))
    await dependencies.persistence.recordStateRevision(destination.filePath, "external")
    await fs.writeFile(destination.filePath, source.data, { flag: "wx", mode: 0o600 })
    sourceBytes = source.data.length
  } else {
    const source = memoryFsPath(fileName)
    assertMemoryAccess(source.filePath, options)
    const sourceStat = await existingMemoryFsTarget(source.filePath)
    if (!sourceStat.isFile()) throw new Error("copy source must be a regular file")
    sourceLabel = source.uri
    sourceBytes = sourceStat.size
    await dependencies.persistence.recordStateRevision(source.filePath, "external")
    await dependencies.persistence.recordStateRevision(destination.filePath, "external")
    await fs.copyFile(source.filePath, destination.filePath, constants.COPYFILE_EXCL)
    await fs.chmod(destination.filePath, 0o600)
    await dependencies.persistence.recordStateRevision(source.filePath, "memory_fs:copy")
  }
  await dependencies.persistence.recordStateRevision(destination.filePath, "memory_fs:copy")
  await syncMemoryAfterWrite()
  return `copied ${sourceLabel} -> ${destination.uri} (${sourceBytes} bytes)`
}

type MemoryResource = { filePath: string; indexed: boolean; root: string }

function memoryResourcePath(uri: unknown): MemoryResource {
  if (typeof uri !== "string" || !uri.trim()) throw new Error("memory URI is required")
  const raw = uri.trim()
  if (!raw.startsWith("memory://")) throw new Error("path must be a memory:// URI")
  const resource = raw.slice("memory://".length)
  if (!resource || resource.includes("?") || resource.includes("#")) {
    throw new Error("memory URI must identify a Markdown file without a query or fragment")
  }
  const normalized = resource.replace(/\\/g, "/")
  if (path.posix.isAbsolute(normalized) || path.posix.extname(normalized).toLowerCase() !== ".md") {
    throw new Error("memory path must be a relative Markdown file")
  }
  if (normalized === "soul.md") {
    return { filePath: path.join(home, "soul.md"), indexed: false, root: home }
  }
  const resolved = path.resolve(MEMORY_ROOT, normalized)
  const relative = path.relative(MEMORY_ROOT, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("memory path escapes the agent memory directory")
  return { filePath: resolved, indexed: true, root: MEMORY_ROOT }
}

async function prepareExistingMemoryResource(resource: MemoryResource): Promise<void> {
  let rootStat: Stats
  try {
    rootStat = await fs.lstat(resource.root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`memory file does not exist: ${resource.filePath}`)
    throw error
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("memory root must be a real directory")

  const parent = path.dirname(resource.filePath)
  const relativeParent = path.relative(resource.root, parent)
  let current = resource.root
  for (const component of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    let stat: Stats
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`memory file does not exist: ${resource.filePath}`)
      throw error
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("memory path contains a non-directory or symbolic link")
  }
  const [realRoot, realParent] = await Promise.all([fs.realpath(resource.root), fs.realpath(parent)])
  const realRelative = path.relative(realRoot, realParent)
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error("memory path resolves outside the agent memory directory")
  }
  let targetStat: Stats
  try {
    targetStat = await fs.lstat(resource.filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`memory file does not exist: ${resource.filePath}`)
    throw error
  }
  if (targetStat.isSymbolicLink()) throw new Error("memory file must not be a symbolic link")
  if (!targetStat.isFile()) throw new Error("memory target must be a regular file")
}

async function updateMemoryResource(
  uri: unknown,
  update: (existing: string, filePath: string) => string,
  expectedHash?: unknown,
  options?: MemoryAccessOptions,
): Promise<string> {
  const resource = memoryResourcePath(uri)
  assertMemoryAccess(resource.filePath, options)
  if (expectedHash !== undefined && (typeof expectedHash !== "string" || !/^[a-f0-9]{40}$/i.test(expectedHash))) {
    throw new Error("expected_hash must be a SHA-1 document hash")
  }
  const virtualSoul = options?.virtualizeSoul === true && resource.filePath === path.join(home, "soul.md")
  if (!virtualSoul) await prepareExistingMemoryResource(resource)
  const existing = virtualSoul ? await dependencies.bootstrap.readFrontendSoul() : await fs.readFile(resource.filePath, "utf8")
  if (expectedHash !== undefined) {
    const actualHash = createHash("sha1").update(existing).digest("hex")
    if (actualHash !== expectedHash.toLowerCase()) {
      throw new Error(`memory document changed since search (${resource.filePath})`)
    }
  }
  const content = update(existing, resource.filePath)
  validateContent(content, true)
  if (virtualSoul) {
    const result = await dependencies.bootstrap.writeFrontendSoul(existing, content)
    const warning = await getWarningForFile(frontendSoulViewPath)
    return `edited virtual memory://soul.md; diff saved to ${result.patchPath}${result.conflicted ? "; unresolved merge markers remain" : ""}${warning}`
  }
  await dependencies.persistence.recordStateRevision(resource.filePath, "external")
  await replaceFile(resource.filePath, content)
  await dependencies.persistence.recordStateRevision(resource.filePath, "edit")
  if (resource.indexed) await syncMemoryAfterWrite()
  const warning = await getWarningForFile(resource.filePath)
  return `edited ${resource.filePath}${warning}`
}

/** Replace one exact source fragment, or initialize an existing empty memory file. */
async function editMemoryResource(
  uri: unknown,
  oldText: unknown,
  newText: unknown,
  expectedHash?: unknown,
  options?: MemoryAccessOptions,
): Promise<string> {
  if (typeof oldText !== "string") throw new Error("old_text is required")
  if (typeof newText !== "string") throw new Error("new_text is required")
  return updateMemoryResource(uri, (existing, filePath) => {
    if (oldText === "") {
      if (existing !== "") throw new Error(`edit failed: empty old_text requires an empty file in ${filePath}`)
      return newText
    }
    const index = existing.indexOf(oldText)
    if (index === -1) throw new Error(`edit failed: old_text not found in ${filePath}`)
    if (existing.indexOf(oldText, index + oldText.length) !== -1) {
      throw new Error(`edit failed: old_text is not unique in ${filePath}`)
    }
    return existing.slice(0, index) + newText + existing.slice(index + oldText.length)
  }, expectedHash, options)
}

/** Apply the same hashline edit engine used by attached client files. */
async function editMemoryResourceHashline(
  uri: unknown,
  edits: unknown,
  expectedHash?: unknown,
  options?: MemoryAccessOptions,
): Promise<string> {
  if (!Array.isArray(edits) || edits.length === 0) throw new Error("memory edits must be a non-empty array")
  const parsed = resolveEditAnchors(edits as HashlineToolEdit[])
  let warnings: string[] | undefined
  const result = await updateMemoryResource(uri, (existing) => {
    const applied = applyHashlineEdits(existing, parsed)
    warnings = applied.warnings
    return applied.content
  }, expectedHash, options)
  return warnings?.length ? `${result}\nWarnings: ${warnings.join("; ")}` : result
}

async function writeSoul(content: unknown, mode: unknown, target?: unknown): Promise<string> {
  const filePath = path.join(home, "soul.md")
  const value = validateContent(content)
  await fs.mkdir(path.dirname(filePath), { recursive: true })

  if (mode === "append") {
    await dependencies.persistence.recordStateRevision(filePath, "external")
    const handle = await fs.open(
      filePath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      await handle.writeFile(value, { encoding: "utf8" })
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.chmod(filePath, 0o600)
    await dependencies.persistence.recordStateRevision(filePath, "writeSoul:append")
    const warning = await getWarningForFile(filePath)
    return `appended ${filePath}${warning}`
  } else if (mode === "patch") {
    if (typeof target !== "string" || !target) {
      throw new Error("target is required when mode is 'patch'")
    }
    let existing: string
    try {
      existing = await fs.readFile(filePath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`cannot patch non-existent file: ${filePath}`)
      }
      throw error
    }

    const index = existing.indexOf(target)
    if (index === -1) {
      throw new Error(`patch failed: target text not found in ${filePath}`)
    }
    if (existing.indexOf(target, index + target.length) !== -1) {
      throw new Error(`patch failed: target text is not unique in ${filePath}`)
    }

    const newContent = existing.slice(0, index) + value + existing.slice(index + target.length)
    await dependencies.persistence.recordStateRevision(filePath, "external")
    await replaceFile(filePath, newContent)
    await dependencies.persistence.recordStateRevision(filePath, "writeSoul:patch")
    const warning = await getWarningForFile(filePath)
    return `patched ${filePath}${warning}`
  } else {
    throw new Error("mode must be append or patch")
  }
}

async function writeMemory(
  relativePath: unknown,
  content: unknown,
  mode: unknown,
  target?: unknown,
  expectedHash?: unknown,
): Promise<string> {
  const filePath = memoryPath(relativePath)
  const value = validateContent(content, mode === "patch")
  await prepareMemoryFile(filePath)
  const tracked = isTrackedStatePath(filePath, home)

  if (mode === "append") {
    if (tracked) await dependencies.persistence.recordStateRevision(filePath, "external")
    const handle = await fs.open(
      filePath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      await handle.writeFile(value, { encoding: "utf8" })
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.chmod(filePath, 0o600)
    if (tracked) await dependencies.persistence.recordStateRevision(filePath, "writeMemory:append")
    await syncMemoryAfterWrite()
    const warning = await getWarningForFile(filePath)
    return `appended ${filePath}${warning}`
  } else if (mode === "patch") {
    if (typeof target !== "string" || !target) {
      throw new Error("target is required when mode is 'patch'")
    }
    let existing: string
    try {
      existing = await fs.readFile(filePath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`cannot patch non-existent file: ${filePath}`)
      }
      throw error
    }
    if (expectedHash !== undefined) {
      if (typeof expectedHash !== "string" || !/^[a-f0-9]{40}$/i.test(expectedHash)) {
        throw new Error("expected_hash must be a SHA-1 document hash")
      }
      const actualHash = createHash("sha1").update(existing).digest("hex")
      if (actualHash !== expectedHash.toLowerCase()) {
        throw new Error(`patch failed: memory document changed since search (${filePath})`)
      }
    }

    const index = existing.indexOf(target)
    if (index === -1) {
      throw new Error(`patch failed: target text not found in ${filePath}`)
    }
    if (existing.indexOf(target, index + target.length) !== -1) {
      throw new Error(`patch failed: target text is not unique in ${filePath}`)
    }

    const newContent = existing.slice(0, index) + value + existing.slice(index + target.length)
    validateContent(newContent, true)
    if (tracked) await dependencies.persistence.recordStateRevision(filePath, "external")
    await replaceFile(filePath, newContent)
    if (tracked) await dependencies.persistence.recordStateRevision(filePath, "writeMemory:patch")
    await syncMemoryAfterWrite()
    const warning = await getWarningForFile(filePath)
    return `patched ${filePath}${warning}`
  } else {
    throw new Error("mode must be append or patch")
  }
}

function isGarbageFile(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower === ".git" ||
    lower === ".ds_store" ||
    lower === ".gitignore" ||
    lower === ".gitattributes" ||
    lower.startsWith(".codex-tmp") ||
    lower.endsWith(".tmp") ||
    lower.endsWith(".temp")
  )
}

async function getFilesRecursively(dir: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const files = await Promise.all(
    entries.map(async (entry) => {
      if (isGarbageFile(entry.name)) return []
      const res = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        return getFilesRecursively(res)
      } else {
        return [res]
      }
    })
  )
  return files.flat()
}

async function getMemoryDirectoryEntries(dir: string, options?: MemoryAccessOptions): Promise<Dirent[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => !(options?.excludeSkills && dir === MEMORY_ROOT && entry.name.toLowerCase() === "skills"))
    .filter((entry) => memoryVisible(path.join(dir, entry.name), options))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
}

async function readMemory(relativePath: unknown, startLine?: unknown, endLine?: unknown, options?: MemoryAccessOptions): Promise<string> {
  const { filePath, displayPath, root } = memoryReadTarget(relativePath)
  assertMemoryAccess(filePath, options)
  if (filePath === MEMORY_ROOT) await fs.mkdir(MEMORY_ROOT, { recursive: true, mode: 0o700 })
  const virtualSoul = options?.virtualizeSoul === true && filePath === path.join(home, "soul.md")
  if (virtualSoul) {
    return formatMemoryRead(displayPath, await dependencies.bootstrap.readFrontendSoul(), startLine, endLine, options?.hashline)
  }
  const stat = await verifyMemoryReadTarget(filePath, root)
  if (stat.isDirectory()) {
    const entries = await getMemoryDirectoryEntries(filePath, options)
    return `${displayPath} is a dir\n${entries.map((entry) => entry.name).join("\n")}`
  }
  const extension = path.extname(filePath).toLowerCase()
  if (!stat.isFile() || (extension !== ".md" && extension !== ".json")) {
    throw new Error("memory path must identify a Markdown/JSON file or directory")
  }

  let content: string
  try {
    content = await fs.readFile(filePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`memory file does not exist: ${filePath}`)
    }
    throw error
  }

  return formatMemoryRead(displayPath, content, startLine, endLine, options?.hashline)
}

function formatMemoryRead(displayPath: string, content: string, startLine?: unknown, endLine?: unknown, hashline = false): string {
  const start = Math.max(1, Math.trunc(Number(startLine)) || 1)
  const lines = content.split("\n")
  if (lines.at(-1) === "") lines.pop()
  const totalLines = lines.length

  const startIdx = start - 1
  const end = endLine !== undefined
    ? Math.max(start, Math.trunc(Number(endLine)) || start)
    : start + 99
  const searchStartIdx = end

  let effectiveEnd: number
  let foundHeaderIdx = -1
  for (let i = searchStartIdx; i < totalLines; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      foundHeaderIdx = i
      break
    }
  }

  if (foundHeaderIdx !== -1) {
    effectiveEnd = foundHeaderIdx
  } else {
    effectiveEnd = Math.min(searchStartIdx, totalLines)
  }

  let selected = lines.slice(startIdx, effectiveEnd)
    .map((line, index) => hashline ? `${startIdx + index + 1}#${computeLineHash(lines, startIdx + index)}: ${line}` : line)
    .join("\n")
  if (effectiveEnd < totalLines) {
    if (foundHeaderIdx !== -1) {
      selected += `\n\n[Note: Content stopped before the next section header on line ${effectiveEnd + 1}. To read further, call 'read_file' with start_line=${effectiveEnd + 1}.]`
    } else {
      selected += `\n\n[Note: Content stopped due to the 100-line read limit. To read further, call 'read_file' with start_line=${effectiveEnd + 1}.]`
    }
  }
  const rangeStr = `lines ${start}–${effectiveEnd}`
  const totalStr = totalLines > 0 ? ` of ${totalLines} total` : ""
  return `[${displayPath}  ${rangeStr}${totalStr}]\n${selected}`
}

async function listMemory(options?: MemoryAccessOptions): Promise<string> {
  await fs.mkdir(MEMORY_ROOT, { recursive: true, mode: 0o700 })
  const absoluteFiles = await getFilesRecursively(MEMORY_ROOT)
  const relativeFiles = absoluteFiles
    .filter((file) => memoryVisible(file, options))
    .map((file) => path.relative(MEMORY_ROOT, file))
  
  if (relativeFiles.length === 0) {
    return "(no memories found)"
  }
  return relativeFiles.sort().join("\n")
}

async function grepMemory(query: unknown, caseInsensitive?: unknown, options?: MemoryAccessOptions): Promise<string> {
  if (typeof query !== "string" || !query) {
    throw new Error("query is required")
  }
  const isCaseInsensitive = caseInsensitive === true

  await fs.mkdir(MEMORY_ROOT, { recursive: true, mode: 0o700 })
  const absoluteFiles = (await getFilesRecursively(MEMORY_ROOT))
    .filter((file) => memoryVisible(file, options))

  const matches: string[] = []
  const searchQuery = isCaseInsensitive ? query.toLowerCase() : query

  for (const file of absoluteFiles) {
    const relativePath = path.relative(MEMORY_ROOT, file)
    let content: string
    try {
      content = await fs.readFile(file, "utf8")
    } catch {
      continue
    }

    const lines = content.split("\n")
    for (let lineNum = 1; lineNum <= lines.length; lineNum++) {
      const line = lines[lineNum - 1]!
      const lineToSearch = isCaseInsensitive ? line.toLowerCase() : line
      if (lineToSearch.includes(searchQuery)) {
        matches.push(`${relativePath}:${lineNum}: ${line}`)
      }
    }
  }

  if (matches.length === 0) {
    return "(no matches found)"
  }
  return matches.join("\n")
}

/**
 * Loads a skill doc from memories/skills/<name>.md, stripping YAML frontmatter,
 * and returns the full body for injection into context. `name` may be given
 * with or without the .md extension.
 */
async function loadSkill(name: unknown): Promise<string> {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("name is required")
  }
  const base = name.trim().replace(/\.md$/i, "")
  // reject path traversal / nested paths — skills are flat files
  if (base.includes("/") || base.includes("\\") || base.includes("..")) {
    throw new Error("skill name must be a bare filename (no path separators)")
  }
  const filePath = path.join(SKILLS_ROOT, `${base}.md`)
  const relative = path.relative(SKILLS_ROOT, filePath)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("skill name escapes the skills directory")
  }

  let content: string
  try {
    content = await fs.readFile(filePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      let available = ""
      try {
        const entries = (await fs.readdir(SKILLS_ROOT))
          .filter((e) => e.endsWith(".md"))
          .map((e) => e.replace(/\.md$/, ""))
        available = entries.length ? ` Available skills: ${entries.sort().join(", ")}.` : ""
      } catch {}
      throw new Error(`skill not found: ${base}.${available}`)
    }
    throw error
  }

  // strip leading YAML frontmatter block
  const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trimStart()
  return `[skill: ${base}]\n${body}`
}

  return {
    memoryFs,
    readMemory,
    listMemory,
    grepMemory,
    editMemoryResource,
    editMemoryResourceHashline,
    writeMemory,
    writeSoul,
    loadSkill,
  }
}
