import assert from "node:assert/strict"
import test from "node:test"
import { fromDiscord } from "../triggers/discord"
import { extractFileAttachments, extractImageAttachments } from "./parse"


test("discord files are exposed as download links in live model context", () => {
  const payload = {
    message: {
      id: "file-message",
      channel_id: "dm-123",
      content: "please review",
      timestamp: "2026-06-15T12:00:00.000Z",
      author: { id: "789", username: "ana" },
      attachments: [
        {
          url: "https://cdn.discordapp.com/attachments/123/456/notes.pdf?ex=abc",
          filename: "notes.pdf",
          content_type: "application/pdf",
          size: 12345,
        },
        {
          url: "https://cdn.discordapp.com/attachments/123/789/photo.png?ex=def",
          filename: "photo.png",
          content_type: "image/png",
          size: 6789,
        },
      ],
    },
    channel: { id: "dm-123", type: 1 },
    is_dm: true,
  }

  assert.deepEqual(extractFileAttachments(payload), [
    {
      url: "https://cdn.discordapp.com/attachments/123/456/notes.pdf?ex=abc",
      filename: "notes.pdf",
      contentType: "application/pdf",
      size: 12345,
    },
  ])
  assert.equal(extractImageAttachments(payload).length, 1)

  const event = fromDiscord(payload)
  assert.match(event.content, /files \(discord cdn download links/)
  assert.match(event.content, /https:\/\/cdn\.discordapp\.com\/attachments\/123\/456\/notes\.pdf\?ex=abc/)
  assert.match(event.content, /notes\.pdf, application\/pdf, 12345 bytes/)
  assert.match(event.content, /images \(discord cdn links/)
})
