import path from "node:path"
import type Database from "better-sqlite3"
import { NANO_HOME } from "./agent-config"
import { markdownExcerptImageReferences, type ContextImageReference } from "./context-images"
import { discordToolImageReferences } from "./discord/context-avatars"

function memoryFile(resource: string, home: string): string {
  if (resource === "memory://soul.md") return path.join(home, "soul.md")
  return path.resolve(home, "memories", resource.replace(/^memory:\/\//, ""))
}

export async function toolContextImageReferences(name: string, args: Record<string, unknown>, text: string, db?: Database.Database, home = NANO_HOME): Promise<ContextImageReference[]> {
  if (text.startsWith("error:")) return []
  if (["discord_inbox", "discord_backread", "discord_search"].includes(name)) return db ? discordToolImageReferences(db, text) : []
  if ((name === "read_file" && String(args.path).startsWith("memory://")) || name === "memory_read") {
    const file = memoryFile(String(args.path), home)
    return path.extname(file).toLowerCase() === ".md" ? markdownExcerptImageReferences(text, file, home) : []
  }
  if (name === "skill") {
    const skill = String(args.name).trim().replace(/\.md$/i, "")
    if (!skill || /[/\\]|\.\./.test(skill)) return []
    return markdownExcerptImageReferences(text, path.join(home, "memories", "skills", `${skill}.md`), home)
  }
  if (name === "memory_search") {
    let results: unknown
    try { results = JSON.parse(text) } catch { return [] }
    if (results && typeof results === "object" && Array.isArray((results as { results?: unknown }).results)) {
      results = (results as { results: unknown[] }).results
    }
    if (!Array.isArray(results)) return []
    const references = await Promise.all(results.map((row) =>
      typeof row?.uri === "string" && row.uri.startsWith("memory://") && typeof row.content === "string"
        ? markdownExcerptImageReferences(row.content, memoryFile(row.uri, home), home) : [],
    ))
    return references.flat()
  }
  return []
}
