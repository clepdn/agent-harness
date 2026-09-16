import assert from "node:assert/strict"
import test from "node:test"
import { initDb } from "../db"
import {
  __friendlyIdTest,
  getOrCreateDiscordFriendlyId,
  resolveDiscordChannelId,
  resolveDiscordFriendlyId,
} from "./friendly-id"
import { resolveDiscordDeliveryTarget } from "./state"

test("Discord friendly ids are unique plant-object-object handles with distinct objects", () => {
  initDb(":memory:")
  const ids = new Set<string>()

  for (let index = 0; index < 1_000; index += 1) {
    const messageId = `message-${index}`
    const id = getOrCreateDiscordFriendlyId(messageId, "channel-a")
    const [plant, firstObject, secondObject] = id.split("-")

    assert.match(id, __friendlyIdTest.pattern)
    assert.ok(__friendlyIdTest.plants.includes(plant as typeof __friendlyIdTest.plants[number]))
    assert.ok(__friendlyIdTest.objects.includes(firstObject as typeof __friendlyIdTest.objects[number]))
    assert.ok(__friendlyIdTest.objects.includes(secondObject as typeof __friendlyIdTest.objects[number]))
    assert.notEqual(firstObject, secondObject)
    assert.ok(!ids.has(id), `duplicate friendly id: ${id}`)
    ids.add(id)
    assert.equal(getOrCreateDiscordFriendlyId(messageId, "channel-a"), id)
  }
})

test("a friendly id resolves as both a channel id and a message reference", async () => {
  initDb(":memory:")
  const id = getOrCreateDiscordFriendlyId("message-a", "channel-a")

  assert.deepEqual(resolveDiscordFriendlyId(id), {
    friendlyId: id,
    messageId: "message-a",
    channelId: "channel-a",
  })
  assert.equal(resolveDiscordChannelId(id), "channel-a")

  const delivery = await resolveDiscordDeliveryTarget({
    referenceMessage: id,
    replyMode: "explicit",
  })
  assert.equal(delivery.channelId, "channel-a")
  assert.equal(delivery.referenceMessageId, "message-a")
})
