import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createAgentStateService } from "./agent-state-tools"
const testConfig = path.resolve(import.meta.dirname, "../../../test-config.json")

function createTestService(home: string) {
  const revisionEvents: Array<{ filePath: string; source: string }> = []
  let syncCount = 0
  const service = createAgentStateService({
    home,
    readClientFile: async (filePath) => { const data = await fs.readFile(filePath); return { path: filePath, name: path.basename(filePath), mime: "application/octet-stream", data } },
    persistence: { recordStateRevision: async (filePath, source) => { revisionEvents.push({ filePath, source }) } },
    bootstrap: {
      readFrontendSoul: async () => { try { return await fs.readFile(path.join(home, "soul.md"), "utf8") } catch { return "" } },
      writeFrontendSoul: async (_expectedSoul, content) => { const patchPath = path.join(home, ".nano", "frontend-soul", "soul.patch"); await fs.mkdir(path.dirname(patchPath), { recursive: true }); await fs.writeFile(patchPath, content); return { patchPath, conflicted: false } },
    },
    syncMemoryIndex: async () => { syncCount++ },
  })
  return { service, revisionEvents, get syncCount() { return syncCount } }
}

test("memory operations reject paths outside the memory directory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-memory-paths-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { service } = createTestService(path.join(root, "home"))
  await assert.rejects(service.readMemory("../escape.md"), /escapes/)
  await assert.rejects(service.readMemory("/tmp/escape.md"), /relative/)
  await assert.rejects(service.writeMemory("notes.txt", "content", "append"), /relative Markdown/)
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
    const { createAgentStateService } = await import(${JSON.stringify(moduleUrl)})
    const revisionEvents = []
    const syncEvents = []
    const service = createAgentStateService({
      home: ${JSON.stringify(home)},
      readClientFile: async (filePath) => {
        const fileFs = await import("node:fs/promises")
        const data = await fileFs.readFile(filePath)
        return { path: filePath, name: filePath.split(/[\\/]/).at(-1) || filePath, mime: "application/octet-stream", data }
      },
      persistence: { recordStateRevision: async (filePath, source) => { revisionEvents.push({ filePath, source }) } },
      bootstrap: {
        readFrontendSoul: async () => {
          const fileFs = await import("node:fs/promises")
          try { return await fileFs.readFile(${JSON.stringify(home)} + "/soul.md", "utf8") } catch { return "" }
        },
        writeFrontendSoul: async (_expectedSoul, content) => {
          const fileFs = await import("node:fs/promises")
          const patchPath = ${JSON.stringify(home)} + "/.nano/frontend-soul/soul.patch"
          await fileFs.mkdir(${JSON.stringify(home)} + "/.nano/frontend-soul", { recursive: true })
          await fileFs.writeFile(patchPath, content)
          return { patchPath, conflicted: false }
        },
      },
      syncMemoryIndex: async () => { syncEvents.push(true) },
    })
    for (const target of ["linked-dir/escaped.md", "linked-file.md"]) {
      let rejected = false
      try { await service.writeMemory(target, "changed", "append") } catch { rejected = true }
      if (!rejected) process.exit(2)
    }
  `
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home, NANO_CONFIG: testConfig },
      stdio: "ignore",
    })
    child.on("error", reject)
    child.on("close", resolve)
  })

  assert.equal(code, 0)
  assert.equal(await fs.readFile(outsideFile, "utf8"), "original")
  await assert.rejects(() => fs.access(path.join(outside, "escaped.md")))
})

test("memory_fs copies executor files into server memory and manages resources", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-memory-fs-"))
  const home = path.join(root, "home")
  const executorDir = path.join(root, "executor")
  const controlDir = path.join(root, "control")
  const memoriesDir = path.join(home, "memories")
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10])
  await fs.mkdir(executorDir, { recursive: true })
  await fs.mkdir(controlDir)
  await fs.writeFile(path.join(executorDir, "image.png"), imageBytes)
  await fs.writeFile(path.join(controlDir, "image.png"), "wrong machine")
  await fs.writeFile(path.join(executorDir, "notes.txt"), "executor notes\n", "utf8")
  await fs.writeFile(path.join(executorDir, "empty.txt"), "")

  const moduleUrl = new URL("./agent-state-tools.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    import path from "node:path"
    const { createAgentStateService } = await import(${JSON.stringify(moduleUrl)})
    const revisionEvents = []
    const syncEvents = []
    const service = createAgentStateService({ home: ${JSON.stringify(home)},
      persistence: { recordStateRevision: async (filePath, source) => { revisionEvents.push({ filePath, source }) } },
      readClientFile: async (filePath) => { const fileFs = await import("node:fs/promises"); const target = path.isAbsolute(filePath) ? filePath : path.join(${JSON.stringify(executorDir)}, filePath); const stat = await fileFs.stat(target); if (!stat.isFile()) throw new Error("client file is not a regular file"); const data = await fileFs.readFile(target); return { path: filePath, name: path.basename(filePath), mime: "application/octet-stream", data } },
      bootstrap: {
        readFrontendSoul: async () => { const fileFs = await import("node:fs/promises"); try { return await fileFs.readFile(${JSON.stringify(home)} + "/soul.md", "utf8") } catch { return "" } },
        writeFrontendSoul: async (_expectedSoul, content) => { const fileFs = await import("node:fs/promises"); const patchPath = ${JSON.stringify(home)} + "/.nano/frontend-soul/soul.patch"; await fileFs.mkdir(${JSON.stringify(home)} + "/.nano/frontend-soul", { recursive: true }); await fileFs.writeFile(patchPath, content); return { patchPath, conflicted: false } },
      },
      syncMemoryIndex: async () => { syncEvents.push(true) },
    })


    assert.match(await service.memoryFs("assets/", "create"), /created directory/)
    assert.match(await service.memoryFs(
      "local://image.png",
      "copy",
      "assets/image.png",
    ), /copied local:/)
    assert.match(await service.memoryFs("assets/image.png", "copy", "archive/image-copy.png"), /copied memory:/)
    assert.match(await service.memoryFs(
      ${JSON.stringify(`local://${path.join(executorDir, "notes.txt")}`)},
      "copy",
      "notes/imported.txt",
    ), /copied local:/)
    assert.match(await service.memoryFs("notes/imported.txt", "move", "notes/renamed.txt"), /moved memory:/)
    await service.memoryFs("local://empty.txt", "copy", "notes/empty.txt")
    await assert.rejects(() => service.memoryFs("local://notes.txt", "copy", "assets/image.png"), /already exists/)
    await assert.rejects(() => service.memoryFs("local://missing.txt", "copy", "notes/missing.txt"))
    await assert.rejects(() => service.memoryFs("local://.", "copy", "notes/directory.txt"), /regular file/)

    await service.memoryFs("temporary/", "create")
    await service.memoryFs("temporary/empty.md", "create")
    await assert.rejects(() => service.memoryFs("temporary", "delete"))
    await service.memoryFs("temporary/empty.md", "delete")
    assert.match(await service.memoryFs("temporary", "delete"), /deleted memory:/)
    await assert.rejects(() => service.memoryFs("local:///tmp/nope", "move", "nope"), /memory-relative/)

  `

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_CONFIG: testConfig, NANO_HOME: home },
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
  assert.equal(await fs.readFile(path.join(memoriesDir, "notes", "renamed.txt"), "utf8"), "executor notes\n")
  assert.equal((await fs.stat(path.join(memoriesDir, "assets", "image.png"))).mode & 0o777, 0o600)
  assert.deepEqual(await fs.readFile(path.join(memoriesDir, "notes", "empty.txt")), Buffer.alloc(0))
  await assert.rejects(() => fs.access(path.join(memoriesDir, "notes", "missing.txt")))
  await assert.rejects(() => fs.access(path.join(memoriesDir, "notes", "directory.txt")))
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
    const { createAgentStateService } = await import(${JSON.stringify(moduleUrl)})
    const revisionEvents = []
    const syncEvents = []
    const service = createAgentStateService({
      home: ${JSON.stringify(home)},
      readClientFile: async (filePath) => {
        const fileFs = await import("node:fs/promises")
        const data = await fileFs.readFile(filePath)
        return { path: filePath, name: filePath.split(/[\\/]/).at(-1) || filePath, mime: "application/octet-stream", data }
      },
      persistence: { recordStateRevision: async (filePath, source) => { revisionEvents.push({ filePath, source }) } },
      bootstrap: {
        readFrontendSoul: async () => {
          const fileFs = await import("node:fs/promises")
          try { return await fileFs.readFile(${JSON.stringify(home)} + "/soul.md", "utf8") } catch { return "" }
        },
        writeFrontendSoul: async (_expectedSoul, content) => {
          const fileFs = await import("node:fs/promises")
          const patchPath = ${JSON.stringify(home)} + "/.nano/frontend-soul/soul.patch"
          await fileFs.mkdir(${JSON.stringify(home)} + "/.nano/frontend-soul", { recursive: true })
          await fileFs.writeFile(patchPath, content)
          return { patchPath, conflicted: false }
        },
      },
      syncMemoryIndex: async () => { syncEvents.push(true) },
    })
    const uri = "memory://journal/today.md"
    await service.memoryFs(uri, "create")
    const emptyHash = createHash("sha1").update("").digest("hex")
    await service.editMemoryResource(uri, "", "# Today\\nfirst entry\\nsecond entry\\n", emptyHash)
    assert.match(await service.readMemory(uri), /# Today/)
    await assert.rejects(() => service.editMemoryResource(uri, "", "overwrite"), /requires an empty file/)
    await assert.rejects(() => service.editMemoryResourceHashline(uri, [{ op: "append", lines: ["stale"] }], emptyHash), /changed since search/)
    const read = await service.readMemory(uri, undefined, undefined, { hashline: true })
    const anchor = read.match(/^(2#[A-Z]+): first entry$/m)?.[1]
    assert.ok(anchor, read)
    assert.ok((await service.readMemory(uri, 2, 2, { hashline: true })).includes(anchor + ": first entry"))
    await service.editMemoryResourceHashline(uri, [{ op: "replace", pos: anchor, lines: ["updated entry"] }])
    await assert.rejects(() => service.editMemoryResourceHashline(uri, [{ op: "replace", pos: anchor, lines: ["stale"] }]), /E_STALE_ANCHOR/)
    const updated = await service.readMemory(uri, undefined, undefined, { hashline: true })
    const updatedAnchor = updated.match(/^(2#[A-Z]+): updated entry$/m)?.[1]
    assert.ok(updatedAnchor, updated)
    await service.editMemoryResourceHashline(uri, [{ op: "append", pos: updatedAnchor, lines: ["anchored addition"] }])
    await service.editMemoryResourceHashline(uri, [{ op: "prepend", lines: ["Preface"] }])
    const ranged = await service.readMemory(uri, undefined, undefined, { hashline: true })
    const rangeStart = ranged.match(/^(3#[A-Z]+): updated entry$/m)?.[1]
    const rangeEnd = ranged.match(/^(4#[A-Z]+): anchored addition$/m)?.[1]
    assert.ok(rangeStart && rangeEnd, ranged)
    await service.editMemoryResourceHashline(uri, [{ op: "replace", pos: rangeStart, end: rangeEnd, lines: ["combined entry"] }])
    await service.editMemoryResourceHashline(uri, [{ op: "replace_text", oldText: "second entry", newText: "final entry" }])
    await assert.rejects(() => service.editMemoryResourceHashline(uri, [{ op: "replace", lines: ["bad"] }]), /requires a "pos" anchor/)
    await assert.rejects(() => service.editMemoryResourceHashline("memory://journal/missing.md", [{ op: "append", lines: ["bad"] }]), /does not exist/)
  `
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home, NANO_CONFIG: testConfig },
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
    const { createAgentStateService } = await import(${JSON.stringify(moduleUrl)})
    const revisionEvents = []
    const syncEvents = []
    const service = createAgentStateService({
      home: ${JSON.stringify(home)},
      readClientFile: async (filePath) => {
        const fileFs = await import("node:fs/promises")
        const data = await fileFs.readFile(filePath)
        return { path: filePath, name: filePath.split(/[\\/]/).at(-1) || filePath, mime: "application/octet-stream", data }
      },
      persistence: { recordStateRevision: async (filePath, source) => { revisionEvents.push({ filePath, source }) } },
      bootstrap: {
        readFrontendSoul: async () => {
          const fileFs = await import("node:fs/promises")
          try { return await fileFs.readFile(${JSON.stringify(home)} + "/soul.md", "utf8") } catch { return "" }
        },
        writeFrontendSoul: async (_expectedSoul, content) => {
          const fileFs = await import("node:fs/promises")
          const patchPath = ${JSON.stringify(home)} + "/.nano/frontend-soul/soul.patch"
          await fileFs.mkdir(${JSON.stringify(home)} + "/.nano/frontend-soul", { recursive: true })
          await fileFs.writeFile(patchPath, content)
          return { patchPath, conflicted: false }
        },
      },
      syncMemoryIndex: async () => { syncEvents.push(true) },
    })
    
    // 1. Success case
    const res = await service.writeMemory("journal.md", "some new text", "patch", "some text")
    assert.match(res, /patched/)
    
    // 2. Reject non-existent target
    await assert.rejects(() => service.writeMemory("journal.md", "new", "patch", "missing content"))
    
    // 3. Reject non-unique target
    await assert.rejects(() => service.writeMemory("journal.md", "new", "patch", "## today"))
  `

  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home, NANO_CONFIG: testConfig },
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
    const [{ createDatabase }, { createMemoryRuntime }, { createAgentStateService }] = await Promise.all([
      import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)}),
      import(${JSON.stringify(new URL("./memory/index.ts", import.meta.url).href)}),
      import(${JSON.stringify(new URL("./agent-state-tools.ts", import.meta.url).href)}),
    ])
    const opened = createDatabase(process.env.NANO_DB_PATH, ${JSON.stringify(home)})
    const memory = createMemoryRuntime({ home: ${JSON.stringify(home)}, persistence: { getDb: () => opened.db, vecAvailable: () => opened.vecAvailable } })
    const revisionEvents = []
    const syncEvents = []
    const service = createAgentStateService({
      home: ${JSON.stringify(home)},
      readClientFile: async (filePath) => { const fileFs = await import("node:fs/promises"); const data = await fileFs.readFile(filePath); return { path: filePath, name: filePath, mime: "application/octet-stream", data } },
      persistence: { recordStateRevision: async (filePath, source) => { revisionEvents.push({ filePath, source }) } },
      bootstrap: { readFrontendSoul: async () => "", writeFrontendSoul: async () => ({ patchPath: "", conflicted: false }) },
      syncMemoryIndex: async () => { syncEvents.push(true); await memory.syncMemoryIndex() },
    })
    await memory.syncMemoryIndex()
    const [result] = await memory.searchMemories("moon cheddar", 5)
    assert.equal(result.uri, "memory://journal/bad.md")
    assert.equal(result.content, "The moon is made of cheddar.\\n\\nThe moon has craters.")
    assert.match(result.documentHash, /^[a-f0-9]{40}$/)
    await service.writeMemory(result.uri, "", "patch", "The moon is made of cheddar.\\n\\n", result.documentHash)
    assert.equal((await memory.searchMemories("moon cheddar", 5)).some((item) => item.content.includes("cheddar")), false)
    await assert.rejects(() => service.writeMemory(result.uri, "", "patch", "The moon has craters.", result.documentHash), /changed since search/)
  `

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home, NANO_DB_PATH: dbPath, NANO_CONFIG: testConfig },
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
    const { createAgentStateService } = await import(${JSON.stringify(moduleUrl)})
    const revisionEvents = []
    const syncEvents = []
    const service = createAgentStateService({
      home: ${JSON.stringify(home)},
      readClientFile: async (filePath) => {
        const fileFs = await import("node:fs/promises")
        const data = await fileFs.readFile(filePath)
        return { path: filePath, name: filePath.split(/[\\/]/).at(-1) || filePath, mime: "application/octet-stream", data }
      },
      persistence: { recordStateRevision: async (filePath, source) => { revisionEvents.push({ filePath, source }) } },
      bootstrap: {
        readFrontendSoul: async () => {
          const fileFs = await import("node:fs/promises")
          try { return await fileFs.readFile(${JSON.stringify(home)} + "/soul.md", "utf8") } catch { return "" }
        },
        writeFrontendSoul: async (_expectedSoul, content) => {
          const fileFs = await import("node:fs/promises")
          const patchPath = ${JSON.stringify(home)} + "/.nano/frontend-soul/soul.patch"
          await fileFs.mkdir(${JSON.stringify(home)} + "/.nano/frontend-soul", { recursive: true })
          await fileFs.writeFile(patchPath, content)
          return { patchPath, conflicted: false }
        },
      },
      syncMemoryIndex: async () => { syncEvents.push(true) },
    })
    
    // 1. Success case
    const res = await service.writeSoul("an advanced coder.", "patch", "an agent named Niri.")
    assert.match(res, /patched/)
    
    // 2. Reject non-existent target
    await assert.rejects(() => service.writeSoul("new", "patch", "missing content"))
    
    // 3. Reject non-unique target
    await assert.rejects(() => service.writeSoul("new", "patch", "I am"))
  `

  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home, NANO_CONFIG: testConfig },
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
    const { createAgentStateService } = await import(${JSON.stringify(moduleUrl)})
    const revisionEvents = []
    const syncEvents = []
    const service = createAgentStateService({
      home: ${JSON.stringify(home)},
      readClientFile: async (filePath) => {
        const fileFs = await import("node:fs/promises")
        const data = await fileFs.readFile(filePath)
        return { path: filePath, name: filePath.split(/[\\/]/).at(-1) || filePath, mime: "application/octet-stream", data }
      },
      persistence: { recordStateRevision: async (filePath, source) => { revisionEvents.push({ filePath, source }) } },
      bootstrap: {
        readFrontendSoul: async () => {
          const fileFs = await import("node:fs/promises")
          try { return await fileFs.readFile(${JSON.stringify(home)} + "/soul.md", "utf8") } catch { return "" }
        },
        writeFrontendSoul: async (_expectedSoul, content) => {
          const fileFs = await import("node:fs/promises")
          const patchPath = ${JSON.stringify(home)} + "/.nano/frontend-soul/soul.patch"
          await fileFs.mkdir(${JSON.stringify(home)} + "/.nano/frontend-soul", { recursive: true })
          await fileFs.writeFile(patchPath, content)
          return { patchPath, conflicted: false }
        },
      },
      syncMemoryIndex: async () => { syncEvents.push(true) },
    })
    
    // 1. Test listMemory (should filter out .git and .gitignore, but keep .legit-hidden.md)
    const filesList = await service.listMemory()
    assert.equal(filesList, ".legit-hidden.md\\ncore.md\\njournal/2026-07-12.md\\njournal/long.md\\njournal/long_sectioned.md\\njournal/sectioned.md")
    
    // 2. Test readMemory whole file
    const contentAll = await service.readMemory("journal/2026-07-12.md")
    assert.match(contentAll, /Line 1\\nLine 2\\nLine 3/)

    // Directory reads use memory:// URIs and list immediate, non-hidden entries.
    const rootDirectory = await service.readMemory("memory://")
    assert.equal(rootDirectory, "memory:// is a dir\\ncore.md\\njournal")
    const journalDirectory = await service.readMemory("memory://journal")
    assert.equal(journalDirectory, "memory://journal is a dir\\n2026-07-12.md\\nlong.md\\nlong_sectioned.md\\nsectioned.md")
    const uriFile = await service.readMemory("memory://journal/2026-07-12.md")
    assert.match(uriFile, /Line 1\\nLine 2\\nLine 3/)
    const soul = await service.readMemory("memory://soul.md")
    assert.match(soul, /A server soul/)
    
    // 3. Test readMemory line ranges
    const contentRange = await service.readMemory("journal/2026-07-12.md", 2, 3)
    assert.match(contentRange, /Line 2\\nLine 3/)
    assert.doesNotMatch(contentRange, /Line 1/)
    
    // 4. Test readMemory non-existent file
    await assert.rejects(() => service.readMemory("missing.md"))
    
    // 5. Test header stopping logic on small file returns all lines when no endLine is specified
    const sec1 = await service.readMemory("journal/sectioned.md", 1)
    assert.match(sec1, /Sec 1\\nContent 1\\n## Sec 2\\nContent 2/)
    assert.doesNotMatch(sec1, /Note: Content stopped/)
    
    // 6. Test that range checks continue past endLine to the next header (e.g. read 1-1 continues to 2)
    const extendedSec = await service.readMemory("journal/sectioned.md", 1, 1)
    assert.match(extendedSec, /Sec 1\\nContent 1/)
    assert.doesNotMatch(extendedSec, /Sec 2/)
    assert.match(extendedSec, /Note: Content stopped before the next section header on line 3/)
    
    // 7. Test reading all sections by passing endLine past the last header
    const bothSecs = await service.readMemory("journal/sectioned.md", 1, 4)
    assert.match(bothSecs, /Sec 1\\nContent 1\\n## Sec 2\\nContent 2/)

    // 8. Test memory_grep exact substring matching
    const grep1 = await service.grepMemory("Content 2")
    assert.match(grep1, /journal\\/sectioned\\.md:4: Content 2/)

    // 9. Test memory_grep case-insensitive matching
    const grep2 = await service.grepMemory("CONTENT 2", true)
    assert.match(grep2, /journal\\/sectioned\\.md:4: Content 2/)

    // 10. Test memory_grep empty result
    const grepEmpty = await service.grepMemory("somethinguniqueandmissing")
    assert.equal(grepEmpty, "(no matches found)")

    // 11. Test 100-line read limit note warning
    const longSec = await service.readMemory("journal/long.md", 1)
    assert.match(longSec, /Note: Content stopped due to the 100-line read limit. To read further, call 'read_file' with start_line=101/)

    // 12. Test default 100-line range extending to next section header
    const longSecHeader = await service.readMemory("journal/long_sectioned.md", 1)
    assert.match(longSecHeader, /Line 105/)
    assert.doesNotMatch(longSecHeader, /Section boundary/)
    assert.match(longSecHeader, /Note: Content stopped before the next section header on line 106/)
  `

  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home, NANO_CONFIG: testConfig },
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("close", resolve)
  })

  assert.equal(code, 0)
})

test("memory and soul validation, warning, and revision history", async (t) => {
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
    import { createPersistenceService } from ${JSON.stringify(new URL("./plugins/persistence.ts", import.meta.url).href)}
    const { createAgentStateService } = await import(${JSON.stringify(moduleUrl)})
    const persistence = createPersistenceService({ path: ${JSON.stringify(path.join(home, "nano.db"))}, home: ${JSON.stringify(home)} })
    await persistence.init()
    const db = persistence.getDb()
    const stateHistory = { recordStateRevision: (filePath, source) => persistence.recordStateRevision(filePath, source) }
    const service = createAgentStateService({
      home: ${JSON.stringify(home)},
      readClientFile: async (filePath) => { const data = await fs.readFile(filePath); return { path: filePath, name: path.basename(filePath), mime: "application/octet-stream", data } },
      persistence: { recordStateRevision: (filePath, source) => stateHistory.recordStateRevision(filePath, source) },
      bootstrap: {
        readFrontendSoul: async () => { try { return await fs.readFile(${JSON.stringify(home)} + "/soul.md", "utf8") } catch { return "" } },
        writeFrontendSoul: async (_expectedSoul, content) => { const patchPath = ${JSON.stringify(home)} + "/.nano/frontend-soul/soul.patch"; await fs.mkdir(path.dirname(patchPath), { recursive: true }); await fs.writeFile(patchPath, content); return { patchPath, conflicted: false } },
      },
      syncMemoryIndex: async () => {},
    })
    const revisions = db.prepare("select content, source from state_revisions where path = ? order by id")
    // 1. Test Markdown Validation (broken header)
    await assert.rejects(
      () => service.writeSoul("##Header without space", "append"),
      /Markdown validation failed/
    )
    
    // 2. Test Markdown Validation (unclosed code blocks)
    await assert.rejects(
      () => service.writeSoul("some text\\n\`\`\`\\ncode block", "append"),
      /Markdown validation failed/
    )
    
    // 3. Track changed contents, but not no-op patches
    await service.writeSoul("# Valid Soul", "append")
    await service.writeSoul("# Updated Soul", "patch", "# Valid Soul")
    const soulRevisions = [
      { content: "# Valid Soul", source: "writeSoul:append" },
      { content: "# Updated Soul", source: "writeSoul:patch" },
    ]
    assert.deepEqual(revisions.all("soul.md"), soulRevisions)
    await service.writeSoul("# Updated Soul", "patch", "# Updated Soul")
    assert.deepEqual(revisions.all("soul.md"), soulRevisions)

    // Preserve out-of-band contents before the tool changes them
    await fs.writeFile(path.join(${JSON.stringify(memoriesDir)}, "core.md"), "# External Core", "utf8")
    await service.writeMemory("core.md", "# Updated Core", "patch", "# External Core")
    assert.deepEqual(revisions.all("memories/core.md"), [
      { content: "# External Core", source: "external" },
      { content: "# Updated Core", source: "writeMemory:patch" },
    ])
    await service.memoryFs("core.md", "delete")
    assert.deepEqual(
      db.prepare("select content_hash, content, source from state_revisions where path = ? order by id desc limit 1").get("memories/core.md"),
      { content_hash: null, content: null, source: "memory_fs:delete" },
    )

    // 4. Test warning when size crosses 200KB
    const huge = "a".repeat(200005)
    const res = await service.writeMemory("huge.md", huge, "append")
    assert.match(res, /Warning: File size is currently/)
    await persistence.close()
  `

  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home, NANO_CONFIG: testConfig },
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
    const { createAgentStateService } = await import(${JSON.stringify(moduleUrl)})
    const revisionEvents = []
    const syncEvents = []
    const service = createAgentStateService({
      home: ${JSON.stringify(home)},
      readClientFile: async (filePath) => {
        const fileFs = await import("node:fs/promises")
        const data = await fileFs.readFile(filePath)
        return { path: filePath, name: filePath.split(/[\\/]/).at(-1) || filePath, mime: "application/octet-stream", data }
      },
      persistence: { recordStateRevision: async (filePath, source) => { revisionEvents.push({ filePath, source }) } },
      bootstrap: {
        readFrontendSoul: async () => {
          const fileFs = await import("node:fs/promises")
          try { return await fileFs.readFile(${JSON.stringify(home)} + "/soul.md", "utf8") } catch { return "" }
        },
        writeFrontendSoul: async (_expectedSoul, content) => {
          const fileFs = await import("node:fs/promises")
          const patchPath = ${JSON.stringify(home)} + "/.nano/frontend-soul/soul.patch"
          await fileFs.mkdir(${JSON.stringify(home)} + "/.nano/frontend-soul", { recursive: true })
          await fileFs.writeFile(patchPath, content)
          return { patchPath, conflicted: false }
        },
      },
      syncMemoryIndex: async () => { syncEvents.push(true) },
    })

    // 1. frontmatter stripped, body preserved, name resolves without .md
    const res = await service.loadSkill("flood")
    assert.match(res, /\\[skill: flood\\]/)
    assert.doesNotMatch(res, /description:/)
    assert.match(res, /body line one/)

    // 2. name with .md extension also works
    const res2 = await service.loadSkill("flood.md")
    assert.match(res2, /body line one/)

    // 3. file without frontmatter returns body as-is
    const bare = await service.loadSkill("bare")
    assert.match(bare, /no frontmatter here/)

    // 4. missing skill rejects and lists what's available
    await assert.rejects(() => service.loadSkill("nope"), /skill not found.*flood/s)

    // 5. path traversal rejected
    await assert.rejects(() => service.loadSkill("../core"), /path separators|escapes/)
    await assert.rejects(() => service.loadSkill(""), /name is required/)
  `

  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home, NANO_CONFIG: testConfig },
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
    const { createAgentStateService } = await import(${JSON.stringify(moduleUrl)})
    const revisionEvents = []
    const syncEvents = []
    const service = createAgentStateService({
      home: ${JSON.stringify(home)},
      readClientFile: async (filePath) => {
        const fileFs = await import("node:fs/promises")
        const data = await fileFs.readFile(filePath)
        return { path: filePath, name: filePath.split(/[\\/]/).at(-1) || filePath, mime: "application/octet-stream", data }
      },
      persistence: { recordStateRevision: async (filePath, source) => { revisionEvents.push({ filePath, source }) } },
      bootstrap: {
        readFrontendSoul: async () => {
          const fileFs = await import("node:fs/promises")
          try { return await fileFs.readFile(${JSON.stringify(home)} + "/soul.md", "utf8") } catch { return "" }
        },
        writeFrontendSoul: async (_expectedSoul, content) => {
          const fileFs = await import("node:fs/promises")
          const patchPath = ${JSON.stringify(home)} + "/.nano/frontend-soul/soul.patch"
          await fileFs.mkdir(${JSON.stringify(home)} + "/.nano/frontend-soul", { recursive: true })
          await fileFs.writeFile(patchPath, content)
          return { patchPath, conflicted: false }
        },
      },
      syncMemoryIndex: async () => { syncEvents.push(true) },
    })
    const policy = { excludeSkills: true, excludeMainSessionArchives: true, allowLocalCopy: false }
    assert.match(await service.readMemory("memory://", undefined, undefined, policy), /core\.md/)
    assert.doesNotMatch(await service.readMemory("memory://", undefined, undefined, policy), /skills/)
    assert.doesNotMatch(await service.listMemory(policy), /skills/)
    assert.doesNotMatch(await service.listMemory(policy), /^discarded-2026-09-11/m)
    assert.match(await service.listMemory(policy), /frontend-discarded-2026-09-11/)
    assert.equal(await service.grepMemory("secret skill marker", false, policy), "(no matches found)")
    assert.equal(await service.grepMemory("owner DM transcript marker", false, policy), "(no matches found)")
    await assert.rejects(() => service.readMemory("memory://skills/hidden.md", undefined, undefined, policy), /skill memories are unavailable/)
    await assert.rejects(() => service.editMemoryResource("memory://skills/hidden.md", "secret", "changed", undefined, policy), /skill memories are unavailable/)
    await assert.rejects(() => service.memoryFs("skills/new.md", "create", undefined, policy), /skill memories are unavailable/)
    await assert.rejects(() => service.readMemory("memory://discarded-2026-09-11.json", undefined, undefined, policy), /main session archives are unavailable/)
    await assert.rejects(
      () => service.memoryFs(${JSON.stringify(`local://${localFile}`)}, "copy", "copied.txt", policy),
      (error) => String(error).includes("local:// copies are unavailable"),
    )
  `
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home, NANO_CONFIG: testConfig },
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stderr }))
  })
  assert.equal(result.code, 0, result.stderr)
})

test("memory_fs ls lists only immediate memory children and enforces listing scope", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nano-memory-fs-ls-"))
  const home = path.join(root, "home")
  const memories = path.join(home, "memories")
  const outside = path.join(root, "outside")
  await fs.mkdir(path.join(memories, "nested", "branch"), { recursive: true })
  await fs.mkdir(path.join(memories, "skills"))
  await fs.mkdir(path.join(memories, "soul.md"))
  await fs.mkdir(path.join(memories, "empty"))
  await fs.mkdir(path.join(memories, "empty-filtered"))
  await fs.mkdir(path.join(outside, "subdir"), { recursive: true })
  await fs.writeFile(path.join(home, "soul.md"), "server soul must stay outside memories", "utf8")
  await fs.writeFile(path.join(home, "sibling.md"), "NANO_HOME sibling must stay outside memories", "utf8")
  await fs.writeFile(path.join(memories, "Alpha.md"), "file content must not be returned by ls", "utf8")
  await fs.writeFile(path.join(memories, "zeta.md"), "zeta content", "utf8")
  await fs.writeFile(path.join(memories, "middle.md"), "middle content", "utf8")
  await fs.writeFile(path.join(memories, "discarded-2026-09-11.JSON"), "archive content", "utf8")
  await fs.writeFile(path.join(memories, "DISCARDED-2026-09-12.json"), "archive content", "utf8")
  await fs.writeFile(path.join(memories, "frontend-discarded-2026-09-13.json"), "frontend archive content", "utf8")
  await fs.writeFile(path.join(memories, "nested", "a.md"), "a content", "utf8")
  await fs.writeFile(path.join(memories, "nested", "z.md"), "z content", "utf8")
  await fs.writeFile(path.join(memories, "nested", "branch", "deep.md"), "deep content", "utf8")
  await fs.writeFile(path.join(memories, "skills", "hidden.md"), "skill content", "utf8")
  await fs.writeFile(path.join(memories, "soul.md", "inside.md"), "memory soul directory", "utf8")
  await fs.writeFile(path.join(memories, "empty-filtered", ".hidden"), "hidden content", "utf8")
  await fs.writeFile(path.join(outside, "outside.md"), "outside symlink content", "utf8")
  await fs.writeFile(path.join(outside, "subdir", "outside-child.md"), "outside parent content", "utf8")
  await fs.symlink(outside, path.join(memories, "linked-dir"))
  await fs.symlink(path.join(outside, "outside.md"), path.join(memories, "linked-file.md"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const moduleUrl = new URL("./agent-state-tools.ts", import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    import fs from "node:fs/promises"
    import path from "node:path"
    const { createAgentStateService } = await import(${JSON.stringify(moduleUrl)})
    const revisionEvents = []
    const syncEvents = []
    const service = createAgentStateService({
      home: ${JSON.stringify(home)},
      readClientFile: async (filePath) => {
        const fileFs = await import("node:fs/promises")
        const data = await fileFs.readFile(filePath)
        return { path: filePath, name: filePath.split(/[\\/]/).at(-1) || filePath, mime: "application/octet-stream", data }
      },
      persistence: { recordStateRevision: async (filePath, source) => { revisionEvents.push({ filePath, source }) } },
      bootstrap: {
        readFrontendSoul: async () => {
          const fileFs = await import("node:fs/promises")
          try { return await fileFs.readFile(${JSON.stringify(home)} + "/soul.md", "utf8") } catch { return "" }
        },
        writeFrontendSoul: async (_expectedSoul, content) => {
          const fileFs = await import("node:fs/promises")
          const patchPath = ${JSON.stringify(home)} + "/.nano/frontend-soul/soul.patch"
          await fileFs.mkdir(${JSON.stringify(home)} + "/.nano/frontend-soul", { recursive: true })
          await fileFs.writeFile(patchPath, content)
          return { patchPath, conflicted: false }
        },
      },
      syncMemoryIndex: async () => { syncEvents.push(true) },
    })
    const memories = path.join(${JSON.stringify(home)}, "memories")
    const policy = { excludeSkills: true, excludeMainSessionArchives: true, allowLocalCopy: false }

    const rootListing = "memory:// is a dir\\nAlpha.md\\nDISCARDED-2026-09-12.json\\ndiscarded-2026-09-11.JSON\\nempty/\\nempty-filtered/\\nfrontend-discarded-2026-09-13.json\\nlinked-dir\\nlinked-file.md\\nmiddle.md\\nnested/\\nskills/\\nsoul.md/\\nzeta.md"
    const actualRootListing = await service.memoryFs("memory://", "ls")
    assert.equal(actualRootListing, rootListing)
    assert.equal(await service.memoryFs(".", "ls"), rootListing)
    assert.equal(await service.memoryFs("nested", "ls"), "memory://nested is a dir\\na.md\\nbranch/\\nz.md")
    assert.equal(await service.memoryFs("nested/", "ls"), "memory://nested is a dir\\na.md\\nbranch/\\nz.md")
    assert.equal(await service.memoryFs("memory://nested/", "ls"), "memory://nested is a dir\\na.md\\nbranch/\\nz.md")
    assert.equal(await service.memoryFs("memory://nested/branch", "ls"), "memory://nested/branch is a dir\\ndeep.md")
    assert.equal(await service.memoryFs("memory://soul.md", "ls"), "memory://soul.md is a dir\\ninside.md")
    assert.doesNotMatch(actualRootListing, /file content|zeta content|server soul|NANO_HOME sibling|outside symlink/)
    assert.doesNotMatch(await service.memoryFs("memory://soul.md", "ls"), /server soul|NANO_HOME sibling/)
    assert.doesNotMatch(await service.memoryFs("nested", "ls"), /deep.md/)
    assert.match(await service.memoryFs("nested/branch", "ls"), /deep.md/)
    await assert.rejects(() => service.memoryFs("sibling.md", "ls"))
    await assert.rejects(() => service.memoryFs("memory://sibling.md", "ls"))
    assert.match(await service.memoryFs("empty", "ls"), /\\(empty directory\\)$/)
    assert.match(await service.memoryFs("empty-filtered", "ls"), /\\(empty directory\\)$/)

    const frontendListing = await service.memoryFs("memory://", "ls", undefined, policy)
    assert.match(frontendListing, /frontend-discarded-2026-09-13\\.json/)
    assert.doesNotMatch(frontendListing, /skills|discarded-2026-09-11|DISCARDED-2026-09-12/)
    await assert.rejects(() => service.memoryFs("skills/", "ls", undefined, policy), /skill memories are unavailable/)
    await assert.rejects(() => service.memoryFs("skills/hidden.md", "ls", undefined, policy), /skill memories are unavailable/)
    await assert.rejects(() => service.memoryFs("discarded-2026-09-11.JSON", "ls", undefined, policy), /main session archives are unavailable/)
    await assert.rejects(() => service.memoryFs("DISCARDED-2026-09-12.json", "ls", undefined, policy), /main session archives are unavailable/)

    for (const target of [null, "", "nested"]) {
      await assert.rejects(() => service.memoryFs("memory://", "ls", target))
    }
    for (const fileName of [
      undefined, null, "",
      "/", ${JSON.stringify(path.join(outside, "outside.md"))}, "memory:///", "../sibling.md", "memory://../sibling.md",
      "memory://nested?query=1", "memory://nested#fragment", "local:///tmp/file.md",
    ]) {
      await assert.rejects(() => service.memoryFs(fileName, "ls"))
    }
    await assert.rejects(() => service.memoryFs("missing", "ls"))
    await assert.rejects(() => service.memoryFs("Alpha.md", "ls"))
    await assert.rejects(() => service.memoryFs("linked-dir", "ls"))
    await assert.rejects(() => service.memoryFs("linked-dir/subdir", "ls"))
    await assert.rejects(() => service.memoryFs("linked-file.md", "ls"))

    await fs.rm(memories, { recursive: true })
    await assert.rejects(() => service.memoryFs(".", "ls"))
    await assert.rejects(() => fs.access(memories))
    await fs.mkdir(path.join(memories, "skills"), { recursive: true })
    await fs.writeFile(path.join(memories, "discarded-private.json"), "private main archive")
    assert.match(await service.memoryFs("memory://", "ls", undefined, policy), /\\(empty directory\\)$/)
    await fs.rm(memories, { recursive: true })
    await fs.symlink(${JSON.stringify(outside)}, memories)
    await assert.rejects(() => service.memoryFs("memory://", "ls"))
  `
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NANO_HOME: home, NANO_CONFIG: testConfig },
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stderr }))
  })
  assert.equal(result.code, 0, result.stderr)
})
