import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { buildBootstrap, createBootstrapHome } from "./bootstrap"

const homePath = await fs.mkdtemp(path.join("/tmp", "nano-bootstrap-test-"))
const bootstrapHome = createBootstrapHome(homePath)
test("bootstrap injects a skills index from frontmatter descriptions", async (t) => {
  await fs.mkdir(homePath, { recursive: true })
  const skillsDir = path.join(homePath, "memories", "skills")
  await fs.mkdir(skillsDir, { recursive: true })
  const withFm = path.join(skillsDir, "zzz-test-skill.md")
  const withoutFm = path.join(skillsDir, "zzz-bare-skill.md")
  await fs.writeFile(withFm, "---\ndescription: does a testable thing\n---\n\n# test skill\nbody\n", "utf8")
  await fs.writeFile(withoutFm, "# bare\nno frontmatter\n", "utf8")
  const soulFile = path.join(homePath, "soul.md")
  await fs.writeFile(soulFile, "I am a test agent.\n", "utf8")
  t.after(() => fs.rm(homePath, { recursive: true, force: true }))
  const messages = await buildBootstrap({ source: "chat", triggeredAt: new Date().toISOString(), content: "hello", raw: null }, null, {}, bootstrapHome)
  const system = String(messages[0]?.content)
  assert.match(system, /`zzz-test-skill`: does a testable thing/)
  assert.match(system, /`zzz-bare-skill`: \(no description/)
  assert.match(system, /top-level `old_text`\/`new_text` exact replacement/)
  const hashlineMessages = await buildBootstrap({ source: "chat", triggeredAt: new Date().toISOString(), content: "hello", raw: null }, null, { workspace: { id: "client", root: "/client", hashline: true } }, bootstrapHome)
  const hashlineSystem = String(hashlineMessages[0]?.content)
  assert.match(hashlineSystem, /structured `edits` using anchors from `read_file`/)
  assert.match(hashlineSystem, /edits: \[\{ op: "replace_text"/)
  assert.doesNotMatch(hashlineSystem, /exact `content` as `old_text`/)
})

test("bootstrap restores a rest summary as its own provenance-bearing message", async () => {
  const forest = "[context summary v1]\n[segments]\n[context-summary-id sum_00000000-0000-4000-8000-000000000000]\nolder living summary"
  const messages = await buildBootstrap({ source: "chat", triggeredAt: new Date().toISOString(), content: "wake up", raw: null }, { restedAt: new Date().toISOString(), note: "sleepy", forest }, undefined, bootstrapHome)
  assert.equal(messages[1]?.content, forest)
  assert.match(String(messages[2]?.content), /context_summary_restored: yes/)
  assert.doesNotMatch(String(messages[2]?.content), /older living summary/)
})

test("frontend bootstrap shares soul and memories without exposing skills or executor", async () => {
  const soulFile = path.join(homePath, "soul.md")
  const skillFile = path.join(homePath, "memories", "skills", "zzz-frontend-hidden.md")
  await fs.mkdir(path.dirname(skillFile), { recursive: true })
  await fs.writeFile(soulFile, "I am the shared test soul.\n", "utf8")
  await fs.writeFile(skillFile, "---\ndescription: frontend must not see this marker\n---\nbody", "utf8")
  const messages = await buildBootstrap({ source: "discord", triggeredAt: new Date().toISOString(), content: "hello", raw: null }, null, { frontend: true, discord: true, agentChannel: true, vision: true }, bootstrapHome)
  const system = String(messages[0]?.content)
  assert.match(system, /shared test soul/)
  assert.match(system, /virtual frontend agent/)
  assert.match(system, /agent_send/)
  assert.doesNotMatch(system, /zzz-frontend-hidden/)
  assert.doesNotMatch(system, /- `skill`:/)
  assert.match(system, /`image_tool`: fetch an image from a public HTTP\(S\) URL/)
  assert.match(system, /local image paths.*unavailable/)
})
