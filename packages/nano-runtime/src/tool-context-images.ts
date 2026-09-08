import path from "node:path"
import { NANO_HOME } from "./agent-config"
import { markdownExcerptImageReferences, type ContextImageReference } from "./context-images"
import { discordToolImageReferences } from "./discord/context-avatars"

function memoryFile(resource: string): string {
  if (resource === "memory://soul.md") return path.join(NANO_HOME, "soul.md")
  return path.resolve(NANO_HOME, "memories", resource.replace(/^memory:\/\//, ""))
}

export async function toolContextImageReferences(name: string, args: Record<string, unknown>, text: string): Promise<ContextImageReference[]> {
  if (text.startsWith("error:")) return []
  if (["discord_inbox", "discord_backread", "discord_search"].includes(name)) return discordToolImageReferences(text)
  if ((name === "read_file" && String(args.path).startsWith("memory://")) || name === "memory_read") {
    const file = memoryFile(String(args.path))
    return path.extname(file).toLowerCase() === ".md" ? markdownExcerptImageReferences(text, file) : []
  }
  if (name === "skill") {
    const skill = String(args.name).trim().replace(/\.md$/i, "")
    if (!skill || /[/\\]|\.\./.test(skill)) return []
    return markdownExcerptImageReferences(text, path.join(NANO_HOME, "memories", "skills", `${skill}.md`))
  }
  if (name === "memory_search") {
    let results: unknown
    try { results = JSON.parse(text) } catch { return [] }
    if (!Array.isArray(results)) return []
    const references = await Promise.all(results.map((row) =>
      typeof row?.uri === "string" && row.uri.startsWith("memory://") && typeof row.content === "string"
        ? markdownExcerptImageReferences(row.content, memoryFile(row.uri)) : [],
    ))
    return references.flat()
  }
  return []
}
