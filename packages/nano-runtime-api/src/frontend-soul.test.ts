import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import test, { after } from "node:test"
import { createFrontendSoulStore } from "./frontend-soul"
import { createAgentStateService } from "./agent-state-tools"

const home = await fs.mkdtemp("/tmp/nano-frontend-soul-test-")
process.env.NANO_HOME = home
process.env.NANO_AGENT_STATE_DIR = path.join(home, "state")
after(() => fs.rm(home, { recursive: true, force: true }))
const store = createFrontendSoulStore(home)
const { readFrontendSoul, reconcileFrontendSoul, writeFrontendSoul, viewPath: FRONTEND_SOUL_VIEW_PATH, patchPath: FRONTEND_SOUL_PATCH_PATH } = store
const revisionEvents: Array<{ filePath: string; source: string }> = []
let syncCount = 0
const agentState = createAgentStateService({
  home,
  readClientFile: async (filePath) => { const data = await fs.readFile(filePath); return { path: filePath, name: path.basename(filePath), mime: "application/octet-stream", data } },
  persistence: { recordStateRevision: async (filePath, source) => { revisionEvents.push({ filePath, source }) } },
  bootstrap: { readFrontendSoul, writeFrontendSoul },
  syncMemoryIndex: async () => { syncCount++ },
})

const mainSoulPath = path.join(home, "soul.md")
const frontendPolicy = { virtualizeSoul: true }

test("frontend soul edits persist a patch and cleanly rebase on main changes", async () => {
  const original = "# Identity\nI am main.\n\n# Style\nWarm.\n"
  await fs.writeFile(mainSoulPath, original)
  const initial = await reconcileFrontendSoul()
  assert.equal(initial.soul, original)
  assert.equal(initial.requiresFreshSession, false)

  const editResult = await agentState.editMemoryResource("memory://soul.md", "Warm.", "Curious.", undefined, frontendPolicy)
  assert.match(editResult, /edited virtual memory:\/\/soul\.md; diff saved/)
  assert.equal(await fs.readFile(mainSoulPath, "utf8"), original)
  assert.match(await fs.readFile(FRONTEND_SOUL_PATCH_PATH, "utf8"), /\+Curious\./)
  assert.match(await agentState.readMemory("memory://soul.md", undefined, undefined, frontendPolicy), /Curious\./)
  assert.match(await agentState.readMemory("memory://soul.md"), /Warm\./)

  const newMain = original.replace("I am main.", "I am updated main.")
  await fs.writeFile(mainSoulPath, newMain)
  const rebased = await reconcileFrontendSoul()
  assert.equal(rebased.mainChanged, true)
  assert.equal(rebased.conflicted, false)
  assert.equal(rebased.requiresFreshSession, true)
  assert.match(rebased.soul, /I am updated main\./)
  assert.match(rebased.soul, /Curious\./)
  assert.equal(await fs.readFile(mainSoulPath, "utf8"), newMain)
})

test("overlapping main/frontend edits expose merge markers until frontend resolves them", async () => {
  const priorMain = await fs.readFile(mainSoulPath, "utf8")
  const priorFrontend = await readFrontendSoul()
  const authored = priorFrontend.replace("Curious.", "Playful.")
  await writeFrontendSoul(priorFrontend, authored)
  const newMain = priorMain.replace("Warm.", "Reserved.")
  // The current base is the main soul after the previous clean rebase.
  await fs.writeFile(mainSoulPath, newMain)

  const conflict = await reconcileFrontendSoul()
  assert.equal(conflict.conflicted, true)
  assert.equal(conflict.requiresFreshSession, true)
  assert.match(conflict.soul, /^<<<<<<< main soul\.md$/m)
  assert.match(conflict.soul, /Reserved\./)
  assert.match(conflict.soul, /Playful\./)
  assert.match(conflict.soul, /^>>>>>>> frontend soul\.md$/m)
  assert.equal(await fs.readFile(FRONTEND_SOUL_VIEW_PATH, "utf8"), conflict.soul)
  assert.equal(await fs.readFile(mainSoulPath, "utf8"), newMain)

  const resolved = "# Identity\nI am updated main.\n\n# Style\nReserved and playful.\n"
  const result = await writeFrontendSoul(conflict.soul, resolved)
  assert.equal(result.conflicted, false)
  assert.equal((await reconcileFrontendSoul()).conflicted, false)
  assert.equal(await readFrontendSoul(), resolved)
  assert.equal(await fs.readFile(mainSoulPath, "utf8"), newMain)
  assert.match(await fs.readFile(FRONTEND_SOUL_PATCH_PATH, "utf8"), /\+Reserved and playful\./)
})

test("frontend hashline soul edits remain virtual", async () => {
  const mainBefore = await fs.readFile(mainSoulPath, "utf8")
  const view = await agentState.readMemory("memory://soul.md", undefined, undefined, { ...frontendPolicy, hashline: true })
  const current = await readFrontendSoul()
  const currentLine = current.split("\n").find((line) => line.includes("Reserved and playful."))
  assert.ok(currentLine)
  const escaped = currentLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const anchor = view.match(new RegExp(`^(\\d+#[A-Z]+): ${escaped}$`, "m"))?.[1]
  assert.ok(anchor)
  const result = await agentState.editMemoryResourceHashline(
    "memory://soul.md",
    [{ op: "replace", pos: anchor, lines: ["Still reserved and playful."] }],
    undefined,
    frontendPolicy,
  )
  assert.match(result, /edited virtual memory:\/\/soul\.md/)
  assert.equal(await fs.readFile(mainSoulPath, "utf8"), mainBefore)
  assert.match(await readFrontendSoul(), /Still reserved and playful\./)
})
