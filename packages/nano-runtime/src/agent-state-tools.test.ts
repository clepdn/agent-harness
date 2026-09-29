import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { readMemory, writeMemory } from "./agent-state-tools"

test("memory operations reject paths outside the memory directory", async () => {
  await assert.rejects(readMemory("../escape.md"), /escapes/)
  await assert.rejects(readMemory("/tmp/escape.md"), /relative/)
  await assert.rejects(writeMemory("notes.txt", "content", "append"), /relative Markdown/)
})

test("memory writes reject symlinked directories and files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-memory-symlink-"))
  const home = path.join(root, "home")
  const outside = path.join(root, "outside")
  await fs.mkdir(path.join(home, "memories"), { recursive: true })
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(home, "memories", "linked-dir"))
  const outsideFile = path.join(outside, "outside.md")
  await fs.writeFile(outsideFile, "original")
  await fs.symlink(outsideFile, path.join(home, "memories", "linked-file.md"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const moduleUrl = new URL("./agent-state-tools.ts", import.meta.url).href
  const script = `
    const { writeMemory } = await import(${JSON.stringify(moduleUrl)})
    for (const target of ["linked-dir/escaped.md", "linked-file.md"]) {
      let rejected = false
      try { await writeMemory(target, "changed", "append") } catch { rejected = true }
      if (!rejected) process.exit(2)
    }
  `
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home },
      stdio: "ignore",
    })
    child.on("error", reject)
    child.on("close", resolve)
  })

  assert.equal(code, 0)
  assert.equal(await fs.readFile(outsideFile, "utf8"), "original")
  await assert.rejects(() => fs.access(path.join(outside, "escaped.md")))
})

test("memory_fs manages memory resources and copies container files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-memory-fs-"))
  const home = path.join(root, "home")
  const localDir = path.join(root, "local")
  const memoriesDir = path.join(home, "memories")
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10])
  await fs.mkdir(localDir, { recursive: true })
  await fs.writeFile(path.join(localDir, "image.png"), imageBytes)
  await fs.writeFile(path.join(localDir, "notes.txt"), "container notes\n", "utf8")
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const moduleUrl = new URL("./agent-state-tools.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    const { memoryFs } = await import(${JSON.stringify(moduleUrl)})

    assert.match(await memoryFs("assets/", "create"), /created directory/)
    assert.match(await memoryFs(
      ${JSON.stringify(`local://${path.join(localDir, "image.png")}`)},
      "copy",
      "assets/image.png",
    ), /copied local:/)
    assert.match(await memoryFs("assets/image.png", "copy", "archive/image-copy.png"), /copied memory:/)
    assert.match(await memoryFs(
      ${JSON.stringify(`local://${path.join(localDir, "notes.txt")}`)},
      "copy",
      "notes/imported.txt",
    ), /copied local:/)
    assert.match(await memoryFs("notes/imported.txt", "move", "notes/renamed.txt"), /moved memory:/)

    await memoryFs("temporary/", "create")
    await memoryFs("temporary/empty.md", "create")
    await assert.rejects(() => memoryFs("temporary", "delete"))
    await memoryFs("temporary/empty.md", "delete")
    assert.match(await memoryFs("temporary", "delete"), /deleted memory:/)
    await assert.rejects(() => memoryFs("local:///tmp/nope", "move", "nope"), /memory-relative/)
  `

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })

  assert.equal(result.code, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"))
  assert.deepEqual(await fs.readFile(path.join(memoriesDir, "assets", "image.png")), imageBytes)
  assert.deepEqual(await fs.readFile(path.join(memoriesDir, "archive", "image-copy.png")), imageBytes)
  assert.equal(await fs.readFile(path.join(memoriesDir, "notes", "renamed.txt"), "utf8"), "container notes\n")
  await assert.rejects(() => fs.access(path.join(memoriesDir, "notes", "imported.txt")))
  await assert.rejects(() => fs.access(path.join(memoriesDir, "temporary")))
})

test("new memory files accept a first write and hashline edits", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-memory-first-write-"))
  const home = path.join(root, "home")
  const filePath = path.join(home, "memories", "journal", "today.md")
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const moduleUrl = new URL("./agent-state-tools.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    import { createHash } from "node:crypto"
    const { editMemoryResource, editMemoryResourceHashline, memoryFs, readMemory } = await import(${JSON.stringify(moduleUrl)})
    const uri = "memory://journal/today.md"
    await memoryFs(uri, "create")
    const emptyHash = createHash("sha1").update("").digest("hex")
    await editMemoryResource(uri, "", "# Today\\nfirst entry\\nsecond entry\\n", emptyHash)
    assert.match(await readMemory(uri), /# Today/)
    await assert.rejects(() => editMemoryResource(uri, "", "overwrite"), /requires an empty file/)
    await assert.rejects(() => editMemoryResourceHashline(uri, [{ op: "append", lines: ["stale"] }], emptyHash), /changed since search/)
    const read = await readMemory(uri, undefined, undefined, { hashline: true })
    const anchor = read.match(/^(2#[A-Z]+): first entry$/m)?.[1]
    assert.ok(anchor, read)
    assert.ok((await readMemory(uri, 2, 2, { hashline: true })).includes(anchor + ": first entry"))
    await editMemoryResourceHashline(uri, [{ op: "replace", pos: anchor, lines: ["updated entry"] }])
    await assert.rejects(() => editMemoryResourceHashline(uri, [{ op: "replace", pos: anchor, lines: ["stale"] }]), /E_STALE_ANCHOR/)
    const updated = await readMemory(uri, undefined, undefined, { hashline: true })
    const updatedAnchor = updated.match(/^(2#[A-Z]+): updated entry$/m)?.[1]
    assert.ok(updatedAnchor, updated)
    await editMemoryResourceHashline(uri, [{ op: "append", pos: updatedAnchor, lines: ["anchored addition"] }])
    await editMemoryResourceHashline(uri, [{ op: "prepend", lines: ["Preface"] }])
    const ranged = await readMemory(uri, undefined, undefined, { hashline: true })
    const rangeStart = ranged.match(/^(3#[A-Z]+): updated entry$/m)?.[1]
    const rangeEnd = ranged.match(/^(4#[A-Z]+): anchored addition$/m)?.[1]
    assert.ok(rangeStart && rangeEnd, ranged)
    await editMemoryResourceHashline(uri, [{ op: "replace", pos: rangeStart, end: rangeEnd, lines: ["combined entry"] }])
    await editMemoryResourceHashline(uri, [{ op: "replace_text", oldText: "second entry", newText: "final entry" }])
    await assert.rejects(() => editMemoryResourceHashline(uri, [{ op: "replace", lines: ["bad"] }]), /requires a "pos" anchor/)
    await assert.rejects(() => editMemoryResourceHashline("memory://journal/missing.md", [{ op: "append", lines: ["bad"] }]), /does not exist/)
  `
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home },
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stderr }))
  })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(await fs.readFile(filePath, "utf8"), "Preface\n# Today\ncombined entry\nfinal entry\n")
})

test("memory patch mode edits successfully and enforces unique target presence", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-memory-patch-"))
  const home = path.join(root, "home")
  const memoriesDir = path.join(home, "memories")
  await fs.mkdir(memoriesDir, { recursive: true })
  
  const testFile = path.join(memoriesDir, "journal.md")
  await fs.writeFile(testFile, "# Journal\n\n## today\n\nsome text\n\n## today\n\nother text\n", "utf8")
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const moduleUrl = new URL("./agent-state-tools.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    const { writeMemory } = await import(${JSON.stringify(moduleUrl)})
    
    // 1. Success case
    const res = await writeMemory("journal.md", "some new text", "patch", "some text")
    assert.match(res, /patched/)
    
    // 2. Reject non-existent target
    await assert.rejects(() => writeMemory("journal.md", "new", "patch", "missing content"))
    
    // 3. Reject non-unique target
    await assert.rejects(() => writeMemory("journal.md", "new", "patch", "## today"))
  `

  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home },
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("close", resolve)
  })

  assert.equal(code, 0)
  const finalContent = await fs.readFile(testFile, "utf8")
  assert.equal(finalContent, "# Journal\n\n## today\n\nsome new text\n\n## today\n\nother text\n")
})

test("memory URI patch expunges source text and synchronizes the search index", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-memory-expunge-"))
  const home = path.join(root, "home")
  const memoriesDir = path.join(home, "memories", "journal")
  const dbPath = path.join(home, "nano.db")
  await fs.mkdir(memoriesDir, { recursive: true })
  await fs.writeFile(
    path.join(memoriesDir, "bad.md"),
    "# Notes\n\nThe moon is made of cheddar.\n\nThe moon has craters.\n",
    "utf8",
  )
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const script = `
    import assert from "node:assert/strict"

    const [{ initDb }, memory, { writeMemory }] = await Promise.all([
      import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)}),
      import(${JSON.stringify(new URL("./memory/index.ts", import.meta.url).href)}),
      import(${JSON.stringify(new URL("./agent-state-tools.ts", import.meta.url).href)}),
    ])
    initDb(process.env.NANO_DB_PATH)
    await memory.syncMemoryIndex()

    const [result] = await memory.searchMemories("moon cheddar", 5)
    assert.equal(result.uri, "memory://journal/bad.md")
    assert.equal(result.content, "The moon is made of cheddar.\\n\\nThe moon has craters.")
    assert.match(result.documentHash, /^[a-f0-9]{40}$/)

    await writeMemory(result.uri, "", "patch", "The moon is made of cheddar.\\n\\n", result.documentHash)

    assert.equal((await memory.searchMemories("moon cheddar", 5)).some((item) => item.content.includes("cheddar")), false)
    await assert.rejects(
      () => writeMemory(result.uri, "", "patch", "The moon has craters.", result.documentHash),
      /changed since search/,
    )
  `

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home, NANO_DB_PATH: dbPath },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })

  assert.equal(result.code, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"))
})

test("soul patch mode edits successfully and enforces unique target presence", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-soul-patch-"))
  const home = path.join(root, "home")
  await fs.mkdir(home, { recursive: true })
  
  const testFile = path.join(home, "soul.md")
  await fs.writeFile(testFile, "I am an agent named Niri.\nI am very smart.\n", "utf8")
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const moduleUrl = new URL("./agent-state-tools.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    const { writeSoul } = await import(${JSON.stringify(moduleUrl)})
    
    // 1. Success case
    const res = await writeSoul("an advanced coder.", "patch", "an agent named Niri.")
    assert.match(res, /patched/)
    
    // 2. Reject non-existent target
    await assert.rejects(() => writeSoul("new", "patch", "missing content"))
    
    // 3. Reject non-unique target
    await assert.rejects(() => writeSoul("new", "patch", "I am"))
  `

  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home },
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("close", resolve)
  })

  assert.equal(code, 0)
  const finalContent = await fs.readFile(testFile, "utf8")
  assert.equal(finalContent, "I am an advanced coder.\nI am very smart.\n")
})

test("memory read and list tools function correctly", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-memory-read-ls-"))
  const home = path.join(root, "home")
  const memoriesDir = path.join(home, "memories")
  await fs.mkdir(memoriesDir, { recursive: true })
  await fs.writeFile(path.join(home, "soul.md"), "A server soul\n", "utf8")

  await fs.writeFile(path.join(memoriesDir, "core.md"), "Core fact 1\nCore fact 2\n", "utf8")
  await fs.mkdir(path.join(memoriesDir, "journal"), { recursive: true })
  await fs.writeFile(path.join(memoriesDir, "journal", "2026-07-12.md"), "Line 1\nLine 2\nLine 3\n", "utf8")
  await fs.writeFile(path.join(memoriesDir, "journal", "sectioned.md"), "# Sec 1\nContent 1\n## Sec 2\nContent 2\n", "utf8")
  await fs.writeFile(path.join(memoriesDir, "journal", "long.md"), Array.from({ length: 110 }, (_, i) => `Line ${i + 1}`).join("\n"), "utf8")
  await fs.writeFile(path.join(memoriesDir, "journal", "long_sectioned.md"), Array.from({ length: 105 }, (_, i) => `Line ${i + 1}`).concat("## Section boundary", "More content").join("\n"), "utf8")

  // Write hidden files/directories to verify they are filtered out
  await fs.mkdir(path.join(memoriesDir, ".git"), { recursive: true })
  await fs.writeFile(path.join(memoriesDir, ".git", "config"), "some config", "utf8")
  await fs.writeFile(path.join(memoriesDir, ".gitignore"), "node_modules", "utf8")
  await fs.writeFile(path.join(memoriesDir, ".legit-hidden.md"), "legit content", "utf8")

  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const moduleUrl = new URL("./agent-state-tools.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    const { readMemory, listMemory, grepMemory } = await import(${JSON.stringify(moduleUrl)})
    
    // 1. Test listMemory (should filter out .git and .gitignore, but keep .legit-hidden.md)
    const filesList = await listMemory()
    assert.equal(filesList, ".legit-hidden.md\\ncore.md\\njournal/2026-07-12.md\\njournal/long.md\\njournal/long_sectioned.md\\njournal/sectioned.md")
    
    // 2. Test readMemory whole file
    const contentAll = await readMemory("journal/2026-07-12.md")
    assert.match(contentAll, /Line 1\\nLine 2\\nLine 3/)

    // Directory reads use memory:// URIs and list immediate, non-hidden entries.
    const rootDirectory = await readMemory("memory://")
    assert.equal(rootDirectory, "memory:// is a dir\\ncore.md\\njournal")
    const journalDirectory = await readMemory("memory://journal")
    assert.equal(journalDirectory, "memory://journal is a dir\\n2026-07-12.md\\nlong.md\\nlong_sectioned.md\\nsectioned.md")
    const uriFile = await readMemory("memory://journal/2026-07-12.md")
    assert.match(uriFile, /Line 1\\nLine 2\\nLine 3/)
    const soul = await readMemory("memory://soul.md")
    assert.match(soul, /A server soul/)
    
    // 3. Test readMemory line ranges
    const contentRange = await readMemory("journal/2026-07-12.md", 2, 3)
    assert.match(contentRange, /Line 2\\nLine 3/)
    assert.doesNotMatch(contentRange, /Line 1/)
    
    // 4. Test readMemory non-existent file
    await assert.rejects(() => readMemory("missing.md"))
    
    // 5. Test header stopping logic on small file returns all lines when no endLine is specified
    const sec1 = await readMemory("journal/sectioned.md", 1)
    assert.match(sec1, /Sec 1\\nContent 1\\n## Sec 2\\nContent 2/)
    assert.doesNotMatch(sec1, /Note: Content stopped/)
    
    // 6. Test that range checks continue past endLine to the next header (e.g. read 1-1 continues to 2)
    const extendedSec = await readMemory("journal/sectioned.md", 1, 1)
    assert.match(extendedSec, /Sec 1\\nContent 1/)
    assert.doesNotMatch(extendedSec, /Sec 2/)
    assert.match(extendedSec, /Note: Content stopped before the next section header on line 3/)
    
    // 7. Test reading all sections by passing endLine past the last header
    const bothSecs = await readMemory("journal/sectioned.md", 1, 4)
    assert.match(bothSecs, /Sec 1\\nContent 1\\n## Sec 2\\nContent 2/)

    // 8. Test memory_grep exact substring matching
    const grep1 = await grepMemory("Content 2")
    assert.match(grep1, /journal\\/sectioned\\.md:4: Content 2/)

    // 9. Test memory_grep case-insensitive matching
    const grep2 = await grepMemory("CONTENT 2", true)
    assert.match(grep2, /journal\\/sectioned\\.md:4: Content 2/)

    // 10. Test memory_grep empty result
    const grepEmpty = await grepMemory("somethinguniqueandmissing")
    assert.equal(grepEmpty, "(no matches found)")

    // 11. Test 100-line read limit note warning
    const longSec = await readMemory("journal/long.md", 1)
    assert.match(longSec, /Note: Content stopped due to the 100-line read limit. To read further, call 'read_file' with start_line=101/)

    // 12. Test default 100-line range extending to next section header
    const longSecHeader = await readMemory("journal/long_sectioned.md", 1)
    assert.match(longSecHeader, /Line 105/)
    assert.doesNotMatch(longSecHeader, /Section boundary/)
    assert.match(longSecHeader, /Note: Content stopped before the next section header on line 106/)
  `

  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home },
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("close", resolve)
  })

  assert.equal(code, 0)
})

test("memory and soul validation, warning, and backup operations", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-memory-ext-"))
  const home = path.join(root, "home")
  const memoriesDir = path.join(home, "memories")
  await fs.mkdir(memoriesDir, { recursive: true })
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const moduleUrl = new URL("./agent-state-tools.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    import fs from "node:fs/promises"
    import path from "node:path"
    const { writeSoul, writeMemory } = await import(${JSON.stringify(moduleUrl)})
    
    // 1. Test Markdown Validation (broken header)
    await assert.rejects(
      () => writeSoul("##Header without space", "append"),
      /Markdown validation failed/
    )
    
    // 2. Test Markdown Validation (unclosed code blocks)
    await assert.rejects(
      () => writeSoul("some text\\n\`\`\`\\ncode block", "append"),
      /Markdown validation failed/
    )
    
    // 3. Test soul.md and core.md rolling backup (.bak) creation
    await writeSoul("# Valid Soul", "append")
    await writeSoul("# Updated Soul", "patch", "# Valid Soul")
    const soulBakExists = await fs.stat(path.join(${JSON.stringify(home)}, "soul.md.bak")).then(() => true).catch(() => false)
    assert.equal(soulBakExists, true)

    await writeMemory("core.md", "# Valid Core", "append")
    await writeMemory("core.md", "# Updated Core", "patch", "# Valid Core")
    const coreBakExists = await fs.stat(path.join(${JSON.stringify(memoriesDir)}, "core.md.bak")).then(() => true).catch(() => false)
    assert.equal(coreBakExists, true)

    // 4. Test warning when size crosses 200KB
    const huge = "a".repeat(200005)
    const res = await writeMemory("huge.md", huge, "append")
    assert.match(res, /Warning: File size is currently/)
  `

  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home },
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("close", resolve)
  })

  assert.equal(code, 0)
})

test("loadSkill strips frontmatter, resolves names, and rejects bad input", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-skill-"))
  const home = path.join(root, "home")
  const skillsDir = path.join(home, "memories", "skills")
  await fs.mkdir(skillsDir, { recursive: true })
  await fs.writeFile(
    path.join(skillsDir, "flood.md"),
    "---\ndescription: torrent stuff\n---\n\n# flood\n\nbody line one\n",
    "utf8",
  )
  await fs.writeFile(path.join(skillsDir, "bare.md"), "# bare\n\nno frontmatter here\n", "utf8")
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const moduleUrl = new URL("./agent-state-tools.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    const { loadSkill } = await import(${JSON.stringify(moduleUrl)})

    // 1. frontmatter stripped, body preserved, name resolves without .md
    const res = await loadSkill("flood")
    assert.match(res, /\\[skill: flood\\]/)
    assert.doesNotMatch(res, /description:/)
    assert.match(res, /body line one/)

    // 2. name with .md extension also works
    const res2 = await loadSkill("flood.md")
    assert.match(res2, /body line one/)

    // 3. file without frontmatter returns body as-is
    const bare = await loadSkill("bare")
    assert.match(bare, /no frontmatter here/)

    // 4. missing skill rejects and lists what's available
    await assert.rejects(() => loadSkill("nope"), /skill not found.*flood/s)

    // 5. path traversal rejected
    await assert.rejects(() => loadSkill("../core"), /path separators|escapes/)
    await assert.rejects(() => loadSkill(""), /name is required/)
  `

  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home },
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("close", resolve)
  })

  assert.equal(code, 0)
})

test("frontend memory policy hides skills and blocks local copy escape hatches", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-frontend-memory-"))
  const home = path.join(root, "home")
  const memories = path.join(home, "memories")
  await fs.mkdir(path.join(memories, "skills"), { recursive: true })
  await fs.writeFile(path.join(memories, "core.md"), "# Core\nshared marker\n", "utf8")
  await fs.writeFile(path.join(memories, "skills", "hidden.md"), "# Hidden\nsecret skill marker\n", "utf8")
  await fs.writeFile(path.join(memories, "discarded-2026-09-11.json"), "owner DM transcript marker", "utf8")
  await fs.writeFile(path.join(memories, "frontend-discarded-2026-09-11.json"), "frontend transcript marker", "utf8")
  const localFile = path.join(root, "local.txt")
  await fs.writeFile(localFile, "local marker", "utf8")
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const moduleUrl = new URL("./agent-state-tools.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    const { editMemoryResource, grepMemory, listMemory, memoryFs, readMemory } = await import(${JSON.stringify(moduleUrl)})
    const policy = { excludeSkills: true, excludeMainSessionArchives: true, allowLocalCopy: false }
    assert.match(await readMemory("memory://", undefined, undefined, policy), /core\.md/)
    assert.doesNotMatch(await readMemory("memory://", undefined, undefined, policy), /skills/)
    assert.doesNotMatch(await listMemory(policy), /skills/)
    assert.doesNotMatch(await listMemory(policy), /^discarded-2026-09-11/m)
    assert.match(await listMemory(policy), /frontend-discarded-2026-09-11/)
    assert.equal(await grepMemory("secret skill marker", false, policy), "(no matches found)")
    assert.equal(await grepMemory("owner DM transcript marker", false, policy), "(no matches found)")
    await assert.rejects(() => readMemory("memory://skills/hidden.md", undefined, undefined, policy), /skill memories are unavailable/)
    await assert.rejects(() => editMemoryResource("memory://skills/hidden.md", "secret", "changed", undefined, policy), /skill memories are unavailable/)
    await assert.rejects(() => memoryFs("skills/new.md", "create", undefined, policy), /skill memories are unavailable/)
    await assert.rejects(() => readMemory("memory://discarded-2026-09-11.json", undefined, undefined, policy), /main session archives are unavailable/)
    await assert.rejects(
      () => memoryFs(${JSON.stringify(`local://${localFile}`)}, "copy", "copied.txt", policy),
      (error) => String(error).includes("local:// copies are unavailable"),
    )
  `
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home },
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stderr }))
  })
  assert.equal(result.code, 0, result.stderr)
})
