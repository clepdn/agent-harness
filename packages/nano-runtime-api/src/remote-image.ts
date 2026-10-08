import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"
import type { ClientImageArtifact } from "@nano/harness-protocol"
import { IMAGE_MAX_BYTES } from "./container/config"
import { imageMime } from "./context-images"

const MAX_REDIRECTS = 4
const blockedAddresses = new BlockList()

for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv4")

for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv6")

type LookupResult = { address: string; family: number }
type LookupImageHost = (hostname: string) => Promise<LookupResult[]>

export type RemoteImageDependencies = {
  fetch?: typeof globalThis.fetch
  lookup?: LookupImageHost
  maxBytes?: number
}

export function isRemoteImageUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

function publicAddress(address: string): boolean {
  if (address.toLowerCase().startsWith("::ffff:")) return false
  const family = isIP(address)
  return family !== 0 && !blockedAddresses.check(address, family === 6 ? "ipv6" : "ipv4")
}

function validateUrl(raw: string): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error("image URL is invalid") }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("image URL must use HTTP or HTTPS")
  if (url.username || url.password) throw new Error("image URL must not contain credentials")
  if ((url.protocol === "https:" && url.port && url.port !== "443") || (url.protocol === "http:" && url.port && url.port !== "80")) {
    throw new Error("image URL must use the standard HTTP or HTTPS port")
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "")
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("image URL host is not public")
  }
  return url
}

async function assertPublicHost(url: URL, lookupHost: LookupImageHost): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  const literal = isIP(hostname)
  const addresses = literal
    ? [{ address: hostname, family: literal }]
    : await lookupHost(hostname)
  if (addresses.length === 0 || addresses.some(({ address }) => !publicAddress(address))) {
    throw new Error("image URL host does not resolve exclusively to public addresses")
  }
}

async function defaultLookup(hostname: string): Promise<LookupResult[]> {
  return lookup(hostname, { all: true, verbatim: true })
}

async function readBoundedImage(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new Error("image URL returned an empty response")
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel()
    throw new Error(`remote image exceeds the ${maxBytes} byte limit`)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maxBytes) throw new Error(`remote image exceeds the ${maxBytes} byte limit`)
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  return Buffer.concat(chunks)
}

/** Fetch a public image URL into the same artifact shape returned by client image_tool. */
export async function fetchRemoteImage(
  input: string,
  signal?: AbortSignal,
  dependencies: RemoteImageDependencies = {},
): Promise<ClientImageArtifact> {
  const fetchImage = dependencies.fetch ?? globalThis.fetch
  const lookupHost = dependencies.lookup ?? defaultLookup
  const maxBytes = dependencies.maxBytes ?? IMAGE_MAX_BYTES
  let url = validateUrl(input.trim())

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicHost(url, lookupHost)
    const response = await fetchImage(url, { redirect: "manual", signal })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      await response.body?.cancel()
      if (!location) throw new Error(`image URL redirect (${response.status}) had no location`)
      if (redirects === MAX_REDIRECTS) throw new Error("image URL redirected too many times")
      url = validateUrl(new URL(location, url).toString())
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`image URL returned HTTP ${response.status}`)
    }
    const bytes = await readBoundedImage(response, maxBytes)
    const mime = imageMime(bytes)
    return {
      path: url.toString(),
      mime,
      bytes: bytes.length,
      dataUrl: `data:${mime};base64,${bytes.toString("base64")}`,
    }
  }
  throw new Error("image URL redirected too many times")
}
