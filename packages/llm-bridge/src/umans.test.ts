import { test } from "node:test"
import assert from "node:assert/strict"
import { capImagesForUmans, isUmansModel, UMANS_MAX_IMAGES } from "./umans"
import type { OaiContentPart, OaiMessage } from "./translate"

const img = (n: number): OaiContentPart => ({
  type: "image_url",
  image_url: { url: `data:image/png;base64,${n}` },
})
const txt = (text: string): OaiContentPart => ({ type: "text", text })

/** Flatten every surviving image back to its marker number, in order. */
const imageIds = (messages: OaiMessage[]): number[] =>
  messages.flatMap((m) =>
    Array.isArray(m.content)
      ? m.content
          .filter((p) => p.type === "image_url")
          .map((p) => {
            const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url ?? ""
            return Number(url.split(",")[1])
          })
      : [],
  )

test("isUmansModel matches the provider key, then the endpoint host", () => {
  assert.equal(isUmansModel({ provider: "umans" }), true)
  assert.equal(isUmansModel({ provider: "openai", baseUrl: "https://api.code.umans.ai/v1" }), true)
  assert.equal(isUmansModel({ provider: "openai", baseUrl: "https://openrouter.ai/api/v1" }), false)
  assert.equal(isUmansModel({ provider: "openai" }), false)
  assert.equal(isUmansModel({ provider: "openai", baseUrl: "not a url" }), false)
  // Suffix match must respect the label boundary.
  assert.equal(isUmansModel({ provider: "openai", baseUrl: "https://notumans.ai/v1" }), false)
})

test("requests at or under the cap pass through untouched", () => {
  const messages: OaiMessage[] = [
    { role: "user", content: [txt("look"), ...Array.from({ length: UMANS_MAX_IMAGES }, (_, i) => img(i))] },
  ]
  const capped = capImagesForUmans(messages)
  assert.equal(capped.dropped, 0)
  assert.equal(capped.messages, messages)
})

test("only the last ten images survive; older ones are cut", () => {
  const messages: OaiMessage[] = Array.from({ length: 14 }, (_, i) => ({
    role: "user",
    content: [img(i)],
  }))
  const capped = capImagesForUmans(messages)
  assert.equal(capped.dropped, 4)
  assert.deepEqual(imageIds(capped.messages), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
})

test("messages emptied by the cut are dropped, text-bearing ones are kept", () => {
  const messages: OaiMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: [txt("first"), img(0)] },
    // Image-only turn — this is how tool-result screenshots reach the model.
    { role: "user", content: [img(1)] },
    { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "shell", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "t1", content: "ok" },
    { role: "user", content: [txt("latest"), img(2)] },
  ]
  const capped = capImagesForUmans(messages, 1)

  assert.equal(capped.dropped, 2)
  assert.deepEqual(imageIds(capped.messages), [2])
  assert.deepEqual(
    capped.messages.map((m) => m.role),
    ["system", "user", "assistant", "tool", "user"],
  )
  // Text survives where its image was cut.
  assert.deepEqual(capped.messages[1]!.content, [txt("first")])
  // The most recent turn is untouched, images included.
  assert.deepEqual(capped.messages[4]!.content, [txt("latest"), img(2)])
})

test("a single over-cap message keeps its trailing images and all its text", () => {
  const messages: OaiMessage[] = [
    { role: "user", content: [txt("a"), img(0), txt("b"), img(1), img(2), txt("c")] },
  ]
  const capped = capImagesForUmans(messages, 2)

  assert.equal(capped.dropped, 1)
  assert.equal(capped.messages.length, 1)
  assert.deepEqual(capped.messages[0]!.content, [txt("a"), txt("b"), img(1), img(2), txt("c")])
  // Input is not mutated.
  assert.equal((messages[0]!.content as OaiContentPart[]).length, 6)
})
