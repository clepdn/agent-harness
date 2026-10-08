import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { createDatabase } from "@nano/plugin-persistence/db"
import { formatPronounSets, getCachedPronouns, maybeFetchAndCachePronouns } from "./pronouns"

function database(t: TestContext) {
  const db = createDatabase(":memory:").db
  t.after(() => db.close())
  return db
}

test("pronouns formatting tests", () => {
  // Test single sets
  assert.equal(formatPronounSets(["he"]), "he/him")
  assert.equal(formatPronounSets(["she"]), "she/her")
  assert.equal(formatPronounSets(["they"]), "they/them")
  assert.equal(formatPronounSets(["it"]), "it/its")
  assert.equal(formatPronounSets(["any"]), "any")
  assert.equal(formatPronounSets(["ask"]), "ask me")
  assert.equal(formatPronounSets(["avoid"]), "avoid pronouns")
  assert.equal(formatPronounSets(["other"]), "other")

  // Test compound sets
  assert.equal(formatPronounSets(["she", "they"]), "she/they")
  assert.equal(formatPronounSets(["he", "they"]), "he/they")
  assert.equal(formatPronounSets(["she", "it"]), "she/it")
  assert.equal(formatPronounSets(["any", "ask"]), "any/ask me")
})


test("pronouns database caching tests", async (t) => {
  const db = database(t)
  db.prepare("insert into discord_user_pronouns (user_id, pronouns, updated_at) values (?, ?, ?)")
    .run("user1", "she/they", new Date().toISOString())

  assert.equal(getCachedPronouns(db, "user1"), "she/they")
  assert.equal(getCachedPronouns(db, "user-nonexistent"), null)

  const originalFetch = globalThis.fetch
  let fetchCalled = false
  globalThis.fetch = async (url: string | URL | Request): Promise<Response> => {
    fetchCalled = true
    assert.match(String(url), /ids=user2/)
    return new Response(JSON.stringify({
      user2: {
        sets: {
          en: ["he", "they"],
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } })
  }

  try {
    await maybeFetchAndCachePronouns(db, "user2")
    assert.equal(fetchCalled, true)
    assert.equal(getCachedPronouns(db, "user2"), "he/they")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("cancelled pronoun enrichment cannot overwrite the cache after a late response", async (t) => {
  const db = database(t)
  db.prepare("insert into discord_user_pronouns (user_id, pronouns, updated_at) values (?, ?, ?)")
    .run("late-user", "they/them", "2000-01-01T00:00:00.000Z")
  const originalFetch = globalThis.fetch
  let release!: (response: Response) => void
  let started!: () => void
  const fetching = new Promise<void>((resolve) => { started = resolve })
  globalThis.fetch = async () => {
    started()
    return new Promise<Response>((resolve) => { release = resolve })
  }
  const controller = new AbortController()
  try {
    const pending = maybeFetchAndCachePronouns(db, "late-user", controller.signal)
    await fetching
    controller.abort()
    release(new Response(JSON.stringify({ "late-user": { sets: { en: ["she"] } } }), { status: 200 }))
    await pending
    assert.equal(getCachedPronouns(db, "late-user"), "they/them")
  } finally {
    globalThis.fetch = originalFetch
  }
})
