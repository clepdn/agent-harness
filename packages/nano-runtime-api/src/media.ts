/** Byte-format validation shared by image preparation and Discord attachments. */
export function imageMime(bytes: Uint8Array): string {
  const data = Buffer.from(bytes)
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg"
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString())) return "image/gif"
  if (data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP") return "image/webp"
  throw new Error("expected a PNG, JPEG, GIF, or WebP image")
}
