import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { atomicWriteFile, isMissingFileError } from "./durable-file"

export interface FrontendSoulStore {
  readonly viewPath: string
  readonly patchPath: string
  reconcileFrontendSoul(): Promise<FrontendSoulReconciliation>
  readFrontendSoul(): Promise<string>
  writeFrontendSoul(expectedSoul: string, content: string): Promise<{ patchPath: string; conflicted: boolean }>
}

export type FrontendSoulReconciliation = {
  soul: string
  initialized: boolean
  mainChanged: boolean
  conflicted: boolean
  recovered: boolean
  requiresFreshSession: boolean
}

type GitResult = { code: number | null; stdout: string; stderr: string; error?: Error }


async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
}

function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
    child.once("error", (error) => resolve({ code: null, stdout, stderr, error }))
    child.once("close", (code) => resolve({ code, stdout, stderr }))
  })
}

function conflictMarkers(currentMain: string, priorMain: string, frontendSoul: string): string {
  const block = (value: string) => value.endsWith("\n") || value.length === 0 ? value : `${value}\n`
  return [
    "<<<<<<< main soul.md\n",
    block(currentMain),
    "||||||| previous main soul.md\n",
    block(priorMain),
    "=======\n",
    block(frontendSoul),
    ">>>>>>> frontend soul.md\n",
  ].join("")
}

function containsConflictMarkers(content: string): boolean {
  return /^<<<<<<< main soul\.md$/m.test(content) && /^>>>>>>> frontend soul\.md$/m.test(content)
}

async function withMergeFiles<T>(
  currentMain: string,
  priorMain: string,
  frontendSoul: string,
  operation: (temporaryDir: string) => Promise<T>,
): Promise<T> {
  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "nano-frontend-soul-"))
  try {
    await Promise.all([
      fs.writeFile(path.join(temporaryDir, "current.md"), currentMain, "utf8"),
      fs.writeFile(path.join(temporaryDir, "base.md"), priorMain, "utf8"),
      fs.writeFile(path.join(temporaryDir, "frontend.md"), frontendSoul, "utf8"),
    ])
    return await operation(temporaryDir)
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true })
  }
}

async function mergeSouls(currentMain: string, priorMain: string, frontendSoul: string): Promise<{ content: string; conflicted: boolean; recovered: boolean }> {
  return withMergeFiles(currentMain, priorMain, frontendSoul, async (temporaryDir) => {
    const result = await runGit([
      "merge-file", "--diff3", "-p",
      "-L", "main soul.md",
      "-L", "previous main soul.md",
      "-L", "frontend soul.md",
      "current.md", "base.md", "frontend.md",
    ], temporaryDir)
    if (result.code === 0) return { content: result.stdout, conflicted: false, recovered: false }
    if (result.stdout && containsConflictMarkers(result.stdout)) {
      return { content: result.stdout, conflicted: true, recovered: false }
    }
    console.warn(`[frontend soul] git merge-file failed; exposing a whole-file conflict (${result.error?.message ?? (result.stderr.trim() || `exit ${result.code}`)})`)
    return { content: conflictMarkers(currentMain, priorMain, frontendSoul), conflicted: true, recovered: true }
  })
}

function normalizePatchHeaders(patch: string): string {
  return patch
    .replace(/^diff --git .*$/m, "diff --git a/soul.md b/soul.md")
    .replace(/^--- .*$/m, "--- a/soul.md")
    .replace(/^\+\+\+ .*$/m, "+++ b/soul.md")
}

async function createSoulPatch(mainSoul: string, frontendSoul: string): Promise<string> {
  if (mainSoul === frontendSoul) return ""
  return withMergeFiles(mainSoul, "", frontendSoul, async (temporaryDir) => {
    const result = await runGit([
      "diff", "--no-index", "--no-color", "--no-ext-diff", "--",
      "current.md", "frontend.md",
    ], temporaryDir)
    if (result.code === 1 && result.stdout) return normalizePatchHeaders(result.stdout)
    throw new Error(`could not create frontend soul patch: ${result.error?.message ?? (result.stderr.trim() || `git exited ${result.code}`)}`)
  })
}

export function createFrontendSoulStore(home: string): FrontendSoulStore {
  const mainSoulPath = path.join(home, "soul.md")
  const stateDir = path.join(home, ".nano", "frontend-soul")
  const basePath = path.join(stateDir, "base.md")
  const viewPath = path.join(stateDir, "soul.md")
  const patchPath = path.join(stateDir, "soul.patch")
  const conflictPath = path.join(stateDir, "CONFLICT")
  let serial = Promise.resolve()

  const persistState = async (mainSoul: string, frontendSoul: string, conflicted: boolean): Promise<void> => {
    const patch = await createSoulPatch(mainSoul, frontendSoul)
    await Promise.all([atomicWriteFile(basePath, mainSoul), atomicWriteFile(viewPath, frontendSoul)])
    if (patch) await atomicWriteFile(patchPath, patch)
    else await fs.unlink(patchPath).catch((error) => { if (!isMissingFileError(error)) throw error })
    if (conflicted) await atomicWriteFile(conflictPath, "Resolve the conflict markers in the virtual frontend soul.\n")
    else await fs.unlink(conflictPath).catch((error) => { if (!isMissingFileError(error)) throw error })
  }

  const reconcileUnlocked = async (): Promise<FrontendSoulReconciliation> => {
    const currentMain = await readOptional(mainSoulPath) ?? ""
    const [priorMain, priorFrontend] = await Promise.all([readOptional(basePath), readOptional(viewPath)])
    if (priorMain === null && priorFrontend === null) {
      await persistState(currentMain, currentMain, false)
      return { soul: currentMain, initialized: true, mainChanged: false, conflicted: false, recovered: false, requiresFreshSession: false }
    }
    if (priorMain === null || priorFrontend === null) {
      const survivingFrontend = priorFrontend ?? priorMain ?? ""
      const soul = conflictMarkers(currentMain, priorMain ?? "", survivingFrontend)
      await persistState(currentMain, soul, true)
      return { soul, initialized: false, mainChanged: true, conflicted: true, recovered: true, requiresFreshSession: true }
    }
    if (currentMain === priorMain) {
      const conflicted = containsConflictMarkers(priorFrontend) || await readOptional(conflictPath) !== null
      return { soul: priorFrontend, initialized: false, mainChanged: false, conflicted, recovered: false, requiresFreshSession: conflicted }
    }
    if (priorFrontend === priorMain) {
      await persistState(currentMain, currentMain, false)
      return { soul: currentMain, initialized: false, mainChanged: true, conflicted: false, recovered: false, requiresFreshSession: true }
    }
    const merged = await mergeSouls(currentMain, priorMain, priorFrontend)
    await persistState(currentMain, merged.content, merged.conflicted)
    return { soul: merged.content, initialized: false, mainChanged: true, conflicted: merged.conflicted, recovered: merged.recovered, requiresFreshSession: true }
  }

  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = serial.then(operation, operation)
    serial = result.then(() => undefined, () => undefined)
    return result
  }
  return {
    viewPath,
    patchPath,
    reconcileFrontendSoul: () => serialized(reconcileUnlocked),
    readFrontendSoul: () => serialized(async () => (await reconcileUnlocked()).soul),
    writeFrontendSoul: (expectedSoul, content) => serialized(async () => {
      const reconciled = await reconcileUnlocked()
      if (reconciled.soul !== expectedSoul) throw new Error("virtual frontend soul changed since read; read memory://soul.md again")
      const mainSoul = await readOptional(mainSoulPath) ?? ""
      const conflicted = containsConflictMarkers(content)
      await persistState(mainSoul, content, conflicted)
      return { patchPath, conflicted }
    }),
  }
}
