import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { buildBootstrap } from "./bootstrap"
import { NANO_HOME } from "./agent-config"

test("bootstrap injects a skills index from frontmatter descriptions", async (t) => {
  await fs.mkdir(NANO_HOME, { recursive: true })
  const skillsDir = path.join(NANO_HOME, "memories", "skills")
  await fs.mkdir(skillsDir, { recursive: true })
  const withFm = path.join(skillsDir, "zzz-test-skill.md")
  const withoutFm = path.join(skillsDir, "zzz-bare-skill.md")
  await fs.writeFile(withFm, "---\ndescription: does a testable thing\n---\n\n# test skill\nbody\n", "utf8")
  await fs.writeFile(withoutFm, "# bare\nno frontmatter\n", "utf8")

  // skills index only appears in the full (soul-backed) system prompt, so ensure a soul exists
  const soulFile = path.join(NANO_HOME, "soul.md")
  const hadSoul = await fs.readFile(soulFile, "utf8").then(() => true).catch(() => false)
  if (!hadSoul) await fs.writeFile(soulFile, "I am a test agent.\n", "utf8")

  t.after(async () => {
    await fs.rm(withFm, { force: true })
    await fs.rm(withoutFm, { force: true })
    if (!hadSoul) await fs.rm(soulFile, { force: true })
  })

  const messages = await buildBootstrap({
    source: "chat",
    triggeredAt: new Date().toISOString(),
    content: "hello",
    raw: null,
  })
  const system = String(messages[0]?.content)

  assert.match(system, /`zzz-test-skill`: does a testable thing/)
  // files lacking frontmatter still appear, flagged
  assert.match(system, /`zzz-bare-skill`: \(no description/)
})

test("bootstrap restores a rest summary as its own provenance-bearing message", async () => {
  const forest = "[context summary v1]\n[segments]\n[context-summary-id sum_00000000-0000-4000-8000-000000000000]\nolder living summary"
  const messages = await buildBootstrap(
    {
      source: "chat",
      triggeredAt: new Date().toISOString(),
      content: "wake up",
      raw: null,
    },
    {
      restedAt: new Date().toISOString(),
      note: "sleepy",
      forest,
    },
  )

  assert.equal(messages[1]?.content, forest)
  assert.match(String(messages[2]?.content), /context_summary_restored: yes/)
  assert.doesNotMatch(String(messages[2]?.content), /older living summary/)
})
