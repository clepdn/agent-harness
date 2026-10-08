import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { createDatabase } from "../db"
import {
  __friendlyIdTest,
  getOrCreateDiscordFriendlyId,
  resolveDiscordChannelId,
  resolveDiscordFriendlyId,
} from "./friendly-id"
import { resolveDiscordDeliveryTarget } from "./state"

function database(t: TestContext) {
  const db = createDatabase(":memory:").db
  t.after(() => db.close())
  return db
}

test("Discord friendly ids are unique plant-object-object handles with distinct objects", (t) => {
  const db = database(t)
  const ids = new Set<string>()

  for (let index = 0; index < 1_000; index += 1) {
    const messageId = `message-${index}`
    const id = getOrCreateDiscordFriendlyId(db, messageId, "channel-a")
    const [plant, firstObject, secondObject] = id.split("-")

    assert.match(id, __friendlyIdTest.pattern)
    assert.ok(plant && __friendlyIdTest.plants.some((value) => value === plant))
    assert.ok(firstObject && __friendlyIdTest.objects.some((value) => value === firstObject))
    assert.ok(secondObject && __friendlyIdTest.objects.some((value) => value === secondObject))
    assert.notEqual(firstObject, secondObject)
    assert.ok(!ids.has(id), `duplicate friendly id: ${id}`)
    ids.add(id)
    assert.equal(getOrCreateDiscordFriendlyId(db, messageId, "channel-a"), id)
  }
})

test("a friendly id resolves a channel while reply eligibility still applies", async (t) => {
  const db = database(t)
  const id = getOrCreateDiscordFriendlyId(db, "message-a", "channel-a")

  assert.deepEqual(resolveDiscordFriendlyId(db, id), {
    friendlyId: id,
    messageId: "message-a",
    channelId: "channel-a",
  })
  assert.equal(resolveDiscordChannelId(db, id), "channel-a")

  const delivery = await resolveDiscordDeliveryTarget(db, {
    referenceMessage: id,
    replyMode: "explicit",
  })
  assert.equal(delivery.channelId, "channel-a")
  assert.equal(delivery.referenceMessageId, null)
})
