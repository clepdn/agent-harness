/** Shared display/search whitespace normalization for memory and Discord. */
export function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim()
}
