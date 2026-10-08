/**
 * Memory index synchronization — file walking, chunking, embedding sync.
 *
 * @module memory/sync
 */

import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import type Database from "better-sqlite3"
import type { EmbeddingsService } from "../embeddings"
import {
  basenameWithoutExt,
  chunkLargeSection,
  memoryPaths,
  MEMORY_EMBEDDING_BATCH_SIZE,
  MEMORY_EMBEDDING_PROTOTYPES,
  titleFromPath,
  type MemoryChunkInput,
  type MemoryDocumentRow,
  type MemoryKind,
} from "./shared"

// ── hashing ────────────────────────────────────────────────────────────

/**
 * Computes a SHA-1 content hash for deduplication.
 *
 * @param content - File content.
 * @returns Hex-encoded hash.
 */
export function contentHash(content: string): string {
  return createHash("sha1").update(content).digest("hex")
}

/**
 * Computes a SHA-256 hash for embedding input deduplication.
 *
 * @param content - Embedding input text.
 * @returns Hex-encoded hash.
 */
export function embeddingInputHash(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

/**
 * Wraps a number vector as a Float32Array for sqlite-vec.
 *
 * @param vector - Embedding vector.
 * @returns Float32Array suitable for sqlite-vec storage.
 */
export function vectorParam(vector: number[]): Float32Array {
  return new Float32Array(vector)
}

// ── file walking ───────────────────────────────────────────────────────

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function walkMarkdownFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return []

  const found: string[] = []
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await walkMarkdownFiles(fullPath)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".md")) found.push(fullPath)
  }

  return found.sort()
}

async function listMemoryFiles(home: string): Promise<string[]> {
  const memoriesDir = path.join(home, "memories")
  const coreFile = path.join(memoriesDir, "core.md")
  const files: string[] = []
  if (await pathExists(coreFile)) files.push(coreFile)
  files.push(...(await walkMarkdownFiles(path.join(memoriesDir, "journal"))))
  files.push(...(await walkMarkdownFiles(path.join(memoriesDir, "people"))))
  return files
}

// ── markdown parsing / chunking ────────────────────────────────────────

/**
 * Splits a markdown document into titled sections and chunks large paragraphs.
 *
 * @param filePath - Absolute file path (used for title extraction).
 * @param content - Raw markdown content.
 * @returns Document title and array of chunk inputs.
 */
export function parseMarkdownDocument(filePath: string, content: string): { title: string; chunks: MemoryChunkInput[] } {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const h1 = lines.find((line) => /^#\s+/.test(line))
  const title = h1 ? h1.replace(/^#\s+/, "").trim() : titleFromPath(filePath, "Memory")
  const headingStack: string[] = []
  let sectionLines: string[] = []
  let sectionTitle = title
  const chunks: MemoryChunkInput[] = []

  const flushSection = () => {
    const body = sectionLines.join("\n").trim()
    if (!body) {
      sectionLines = []
      return
    }

    const headingPath = headingStack.length > 0 ? headingStack.join(" > ") : null
    const tags = [basenameWithoutExt(filePath), ...headingStack].join(" ").trim()
    for (const part of chunkLargeSection(body)) {
      chunks.push({
        title: sectionTitle || title,
        headingPath,
        text: part,
        tags,
      })
    }
    sectionLines = []
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (!headingMatch) {
      sectionLines.push(line)
      continue
    }

    flushSection()

    const level = headingMatch[1]!.length
    const heading = headingMatch[2]!.trim()
    if (level === 1) {
      sectionTitle = heading || title
      headingStack.length = 0
      continue
    }

    while (headingStack.length >= level - 1) headingStack.pop()
    headingStack.push(heading)
    sectionTitle = heading || title
  }

  flushSection()

  if (chunks.length === 0) {
    const body = content.trim()
    if (body) {
      chunks.push({
        title,
        headingPath: null,
        text: body,
        tags: basenameWithoutExt(filePath),
      })
    }
  }

  return { title, chunks }
}

/**
 * Builds the embedding input text for a memory chunk.
 *
 * @param row - Chunk metadata.
 * @returns Multi-line embedding input.
 */
export function embeddingTextForChunk(
  row: {
    path: string
    kind: MemoryKind
    documentTitle: string
    title: string
    headingPath: string | null
    text: string
    tags?: string | null
  },
  home: string,
): string {
  const relativePath = path.relative(home, row.path)
  return [
    `kind: ${row.kind}`,
    `file: ${relativePath}`,
    `document: ${row.documentTitle}`,
    `title: ${row.title}`,
    row.headingPath ? `section: ${row.headingPath}` : null,
    row.tags ? `tags: ${row.tags}` : null,
    "",
    row.text,
  ]
    .filter((part): part is string => part !== null)
    .join("\n")
}

// ── index sync ─────────────────────────────────────────────────────────

export interface MemoryIndexerDependencies {
  home: string
  db: Database.Database
  vecAvailable: boolean
  embeddings?: EmbeddingsService
}

export interface MemoryIndexer {
  syncMemoryIndex(): Promise<void>
}

const MEMORY_VECTOR_DIMENSIONS = 3072

type MemoryEmbeddingRow = {
  chunkId: number
  path: string
  kind: MemoryKind
  documentTitle: string
  title: string
  headingPath: string | null
  text: string
  tags: string | null
  model: string | null
  dimensions: number | null
  contentHash: string | null
}

/** Construct an indexer bound to one runtime's filesystem and services. */
export function createMemoryIndexer(deps: MemoryIndexerDependencies): MemoryIndexer {
  const { home, db, vecAvailable, embeddings } = deps
  const { journalDir, peopleDir, coreFile } = memoryPaths(home)
  let embeddingSkipWarned = false

  function detectKind(filePath: string): MemoryKind | null {
    if (filePath === coreFile) return "core"
    if (filePath.startsWith(`${journalDir}${path.sep}`)) return "journal"
    if (filePath.startsWith(`${peopleDir}${path.sep}`)) return "people"
    return null
  }

  async function readMemoryDocumentRows(): Promise<Map<string, MemoryDocumentRow>> {
    const rows = db
      .prepare("select id, path, kind, title, content_hash, mtime_ms from memory_documents")
      .all() as MemoryDocumentRow[]

    return new Map(rows.map((row) => [row.path, row]))
  }

  async function syncMemoryIndex(): Promise<void> {
    const files = await listMemoryFiles(home)
    const known = await readMemoryDocumentRows()
    const present = new Set(files)

    const deleteChunksByDocument = db.prepare("delete from memory_chunks where document_id = ?")
    const insertDocument = db.prepare(`
      insert into memory_documents (path, kind, title, mtime_ms, content_hash, updated_at)
      values (@path, @kind, @title, @mtime_ms, @content_hash, datetime('now'))
      on conflict(path) do update set
        kind = excluded.kind,
        title = excluded.title,
        mtime_ms = excluded.mtime_ms,
        content_hash = excluded.content_hash,
        updated_at = datetime('now')
    `)
    const selectDocumentId = db.prepare("select id from memory_documents where path = ?")
    const insertChunk = db.prepare(`
      insert into memory_chunks (document_id, chunk_index, title, heading_path, chunk_text, tags)
      values (?, ?, ?, ?, ?, ?)
    `)
    const deleteDocumentByPath = db.prepare("delete from memory_documents where path = ?")

    const updates: Array<{
      path: string
      kind: MemoryKind
      title: string
      mtimeMs: number
      hash: string
      chunks: MemoryChunkInput[]
      action: "inserted" | "updated"
    }> = []

    for (const filePath of files) {
      const kind = detectKind(filePath)
      if (!kind) continue

      const [content, stat] = await Promise.all([fs.readFile(filePath, "utf-8"), fs.stat(filePath)])
      const hash = contentHash(content)
      const previous = known.get(filePath)
      if (previous && previous.content_hash === hash && previous.mtime_ms === Math.floor(stat.mtimeMs)) continue

      const parsed = parseMarkdownDocument(filePath, content)
      updates.push({
        path: filePath,
        kind,
        title: parsed.title,
        mtimeMs: Math.floor(stat.mtimeMs),
        hash,
        chunks: parsed.chunks,
        action: previous ? "updated" : "inserted",
      })
    }

    db.transaction(() => {
      for (const item of updates) {
        insertDocument.run({
          path: item.path,
          kind: item.kind,
          title: item.title,
          mtime_ms: item.mtimeMs,
          content_hash: item.hash,
        })
        const row = selectDocumentId.get(item.path) as { id: number } | undefined
        if (!row) continue

        deleteChunksByDocument.run(row.id)
        item.chunks.forEach((chunk, index) => {
          insertChunk.run(row.id, index, chunk.title, chunk.headingPath, chunk.text, chunk.tags)
        })

        console.log(
          `[memory] ${item.action} kind=${item.kind} chunks=${item.chunks.length} path=${path.relative(home, item.path)}`,
        )
      }

      for (const filePath of known.keys()) {
        if (present.has(filePath)) continue
        deleteDocumentByPath.run(filePath)
        console.log(`[memory] removed path=${path.relative(home, filePath)}`)
      }
    })()

    await syncMemoryEmbeddings()
  }

  async function syncMemoryEmbeddings(): Promise<void> {
    if (!vecAvailable) return
    db.prepare("delete from memory_embedding_meta where chunk_id not in (select id from memory_chunks)").run()
    db.prepare("delete from memory_chunk_vec where rowid not in (select id from memory_chunks)").run()
    if (!embeddings || !embeddings.configured()) {
      if (!embeddingSkipWarned && embeddings) {
        console.warn("[memory] embeddings disabled: set EMBEDDING_API_KEY")
        embeddingSkipWarned = true
      }
      return
    }
    if (embeddings.dimensions !== MEMORY_VECTOR_DIMENSIONS) {
      if (!embeddingSkipWarned) {
        console.warn(
          `[memory] embeddings disabled: dimensions=${embeddings.dimensions} but sqlite-vec table is ${MEMORY_VECTOR_DIMENSIONS}`,
        )
        embeddingSkipWarned = true
      }
      return
    }

    try {
      await syncMemoryEmbeddingPrototypes()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[memory] prototype embedding sync failed: ${message}`)
      return
    }

    const rows = db
      .prepare(`
        select
          c.id as chunkId,
          d.path as path,
          d.kind as kind,
          d.title as documentTitle,
          c.title as title,
          c.heading_path as headingPath,
          c.chunk_text as text,
          c.tags as tags,
          m.model as model,
          m.dimensions as dimensions,
          m.content_hash as contentHash
        from memory_chunks c
        join memory_documents d on d.id = c.document_id
        left join memory_embedding_meta m on m.chunk_id = c.id
        order by d.kind, d.path, c.chunk_index
      `)
      .all() as MemoryEmbeddingRow[]

    const pending = rows
      .map((row) => {
        const text = embeddingTextForChunk(row, home)
        return { ...row, embeddingText: text, embeddingHash: embeddingInputHash(text) }
      })
      .filter(
        (row) =>
          row.model !== embeddings.model ||
          row.dimensions !== MEMORY_VECTOR_DIMENSIONS ||
          row.contentHash !== row.embeddingHash,
      )

    if (pending.length === 0) return

    const upsertMeta = db.prepare(`
      insert into memory_embedding_meta (chunk_id, model, dimensions, content_hash, updated_at)
      values (?, ?, ?, ?, datetime('now'))
      on conflict(chunk_id) do update set
        model = excluded.model,
        dimensions = excluded.dimensions,
        content_hash = excluded.content_hash,
        updated_at = datetime('now')
    `)
    const upsertVector = db.prepare("insert or replace into memory_chunk_vec(rowid, embedding) values (?, ?)")

    let embedded = 0
    for (let i = 0; i < pending.length; i += MEMORY_EMBEDDING_BATCH_SIZE) {
      const batch = pending.slice(i, i + MEMORY_EMBEDDING_BATCH_SIZE)
      let vectors: number[][]
      try {
        vectors = await embeddings.embedTexts(batch.map((row) => row.embeddingText))
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`[memory] embedding batch failed: ${message}`)
        return
      }

      if (vectors.some((vector) => vector && vector.length !== MEMORY_VECTOR_DIMENSIONS)) {
        console.warn(`[memory] embedding batch skipped: expected ${MEMORY_VECTOR_DIMENSIONS} dimensions`)
        return
      }

      db.transaction(() => {
        batch.forEach((row, index) => {
          const vector = vectors[index]
          if (!vector) return
          upsertVector.run(BigInt(row.chunkId), vectorParam(vector))
          upsertMeta.run(row.chunkId, embeddings.model, MEMORY_VECTOR_DIMENSIONS, row.embeddingHash)
          embedded += 1
        })
      })()
    }

    console.log(`[memory] embedded chunks=${embedded} model=${embeddings.model} dimensions=${MEMORY_VECTOR_DIMENSIONS}`)
  }

  async function syncMemoryEmbeddingPrototypes(): Promise<void> {
    if (!embeddings) return
    const rows = db
      .prepare("select id, name, category, model, dimensions, content_hash as contentHash from memory_embedding_prototypes")
      .all() as Array<{
        id: number
        name: string
        category: string
        model: string
        dimensions: number
        contentHash: string
      }>
    const known = new Map(rows.map((row) => [row.id, row]))
    const pending = MEMORY_EMBEDDING_PROTOTYPES.map((prototype) => ({
      ...prototype,
      hash: embeddingInputHash(`${prototype.category}\n${prototype.name}\n${prototype.text}`),
    })).filter((prototype) => {
      const row = known.get(prototype.id)
      return (
        !row ||
        row.name !== prototype.name ||
        row.category !== prototype.category ||
        row.model !== embeddings.model ||
        row.dimensions !== MEMORY_VECTOR_DIMENSIONS ||
        row.contentHash !== prototype.hash
      )
    })

    if (pending.length === 0) return

    const vectors = await embeddings.embedTexts(pending.map((prototype) => prototype.text))
    if (vectors.some((vector) => vector && vector.length !== MEMORY_VECTOR_DIMENSIONS)) {
      throw new Error(`prototype embedding dimension mismatch: expected ${MEMORY_VECTOR_DIMENSIONS}`)
    }
    const upsertPrototype = db.prepare(`
      insert into memory_embedding_prototypes (id, name, category, model, dimensions, content_hash, updated_at)
      values (?, ?, ?, ?, ?, ?, datetime('now'))
      on conflict(id) do update set
        name = excluded.name,
        category = excluded.category,
        model = excluded.model,
        dimensions = excluded.dimensions,
        content_hash = excluded.content_hash,
        updated_at = datetime('now')
    `)
    const upsertVector = db.prepare("insert or replace into memory_prototype_vec(rowid, embedding) values (?, ?)")

    db.transaction(() => {
      pending.forEach((prototype, index) => {
        const vector = vectors[index]
        if (!vector) return
        upsertVector.run(BigInt(prototype.id), vectorParam(vector))
        upsertPrototype.run(
          prototype.id,
          prototype.name,
          prototype.category,
          embeddings.model,
          MEMORY_VECTOR_DIMENSIONS,
          prototype.hash,
        )
      })
    })()
  }

  return { syncMemoryIndex }
}
