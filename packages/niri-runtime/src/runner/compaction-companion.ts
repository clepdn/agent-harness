/**
 * Companion compaction pipeline.
 *
 * Where a coding agent's discarded history is disposable scaffolding, a
 * persistent companion's history is relational — the throughline of a
 * conversation, the emotional texture, the callbacks. This module adds the two
 * layers a plain summarizer lacks:
 *
 *   Layer 1 — journal-first: before the forest is burned, the same-model
 *   summary that is about to replace the middle history is ALSO written to the
 *   agent's durable, indexed journal. The in-context summary is ephemeral
 *   working memory; the journal is forever-memory that survives across
 *   sessions. So the summary does not have to carry the whole emotional load —
 *   the journal does.
 *
 *   Layer 3 — deep archive: the specifics a summary compresses away (a quote,
 *   a URL, a number) are preserved out-of-band so an exact detail can be
 *   re-derived instead of guessed. The backend is provider-aware:
 *     - OpenAI    → provider-native remote compaction (config endpoint)
 *     - Anthropic → text appendix (real bitmap snapcompact frames are a
 *                   follow-up once the native renderer is vendored)
 *
 * Layer 2 (the same-model directed summary itself) lives in summarize.ts and is
 * invoked by the loop; this module wraps it with layers 1 and 3.
 */

import { readFileSync } from "node:fs"
import { writeMemory } from "../agent-state-tools"
import type { Message } from "../types"
import {
  JOURNAL_BEFORE_COMPACTION,
  REMOTE_COMPACTION_ENDPOINT,
  REMOTE_COMPACTION_MODEL,
} from "./config"
import { modelState } from "./model-state"
import { messageStringContent } from "./messages"

/** UTC date stamp for the journal path (journal/YYYY-MM-DD.md). */
function journalDateStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/**
 * Layer 1: mirror a compaction summary into the durable journal.
 *
 * Best-effort — a journaling failure must never block the compaction that
 * frees context. Returns true if the write succeeded.
 */
export async function journalCompactionSummary(summaryText: string): Promise<boolean> {
  if (!JOURNAL_BEFORE_COMPACTION) return false
  const trimmed = summaryText.trim()
  if (!trimmed) return false
  const stamp = journalDateStamp()
  const heading = `\n\n## context compaction (${new Date().toISOString()})\n\n` +
    `_auto-captured before burning older history — this is what the same-model summary carried forward:_\n\n`
  try {
    await writeMemory(`journal/${stamp}.md`, `${heading}${trimmed}\n`, "append")
    return true
  } catch (err) {
    console.warn(`[compaction] journal-first write failed: ${(err as Error)?.message ?? err}`)
    return false
  }
}

// ── Deep archive (layer 3) ──────────────────────────────────────────────────

export interface DeepArchiveResult {
  /** Human-readable note describing what was archived (for logs/metrics). */
  note: string
  /** Optional message to append to the conversation carrying the archive. */
  archiveMessage?: Message
}

export interface DeepArchiveBackend {
  readonly name: string
  archive(discarded: Message[]): Promise<DeepArchiveResult | null>
}

/** Serialize discarded messages into a compact scoped transcript. */
function serializeDiscarded(discarded: Message[], maxChars: number): { text: string; truncated: number } {
  const lines: string[] = []
  for (const m of discarded) {
    const role = (m as { role?: string }).role ?? "?"
    const body = messageStringContent(m).replace(/\s+/g, " ").trim()
    if (!body) continue
    lines.push(`¶${role}: ${body}`)
  }
  const full = lines.join("\n")
  if (full.length <= maxChars) return { text: full, truncated: 0 }
  // Keep the head and tail; the middle is the most compressible.
  const headChars = Math.floor(maxChars * 0.6)
  const tailChars = maxChars - headChars
  const truncated = full.length - maxChars
  return {
    text: `${full.slice(0, headChars)}\n… [${truncated.toLocaleString()} chars elided] …\n${full.slice(-tailChars)}`,
    truncated,
  }
}

const DEEP_ARCHIVE_MAX_CHARS = 24_000

/**
 * Anthropic (and default) backend. The real snapcompact bitmap frames need the
 * native rasterizer; until that is vendored, preserve the discarded specifics
 * as a collapsed text appendix so exact details survive the burn.
 */
export class TextAppendixArchive implements DeepArchiveBackend {
  readonly name = "text-appendix"
  async archive(discarded: Message[]): Promise<DeepArchiveResult | null> {
    if (discarded.length === 0) return null
    const { text, truncated } = serializeDiscarded(discarded, DEEP_ARCHIVE_MAX_CHARS)
    if (!text) return null
    const note = `text-appendix archive of ${discarded.length} msg(s)` +
      (truncated > 0 ? ` (${truncated.toLocaleString()} chars elided)` : "")
    const archiveMessage: Message = {
      role: "user",
      content:
        "[deep archive] Verbatim specifics from older turns that the summary above compressed. " +
        "Treat this as a reference appendix — do not re-narrate it; consult it only when an exact detail matters.\n\n" +
        text,
      timestamp: Date.now(),
    }
    return { note, archiveMessage }
  }
}

/**
 * OpenAI backend. When a remote compaction endpoint is configured, the provider
 * holds and replaces history server-side, so nothing is appended locally — the
 * archive lives on their side. This is the seam a future gpt-5.6 (terra) swap
 * rides on. Without an endpoint it declines so the caller falls back.
 */
export class OpenAiRemoteArchive implements DeepArchiveBackend {
  readonly name = "openai-remote"
  async archive(_discarded: Message[]): Promise<DeepArchiveResult | null> {
    if (!REMOTE_COMPACTION_ENDPOINT) return null
    // The remote transport replaces history via the provider's compaction API;
    // the loop performs the actual call through the bridge. Here we only report
    // intent so the orchestrator can route to the remote path.
    return {
      note: `openai-remote archive via ${REMOTE_COMPACTION_ENDPOINT}` +
        (REMOTE_COMPACTION_MODEL ? ` (model ${REMOTE_COMPACTION_MODEL})` : ""),
    }
  }
}

// ── snapcompact native renderer loader ──────────────────────────────────────
// @oh-my-pi/pi-natives ships the rasterizer as a native (napi) addon whose
// binary comes from a platform-specific optionalDependency.
//
// Failure policy (deliberate — see the design discussion):
//   • LOAD failure is a startup concern. If snapcompact frames are the
//     configured deep-archive path, initSnapcompactRenderer() is called during
//     boot and THROWS if the addon won't load — the service fails to start,
//     loud, at the cheap time. We never limp along silently masking a broken
//     setup by pretending the text appendix was intended.
//   • Per-RENDER failure is a runtime, hot-path concern. A single
//     renderSnapcompactPng() throwing mid-compaction degrades that one burn to
//     null (the summary already ran; the frame is gravy). Crashing a live
//     session over one bad frame would be backwards.

type RenderSnapcompactPng = (
  text: string,
  options: { size: number; font?: string; variant?: string; lineRepeat?: number; columns?: number },
) => Promise<string>

let snapcompactRendererCache: RenderSnapcompactPng | null | undefined

/**
 * Resolve the native renderer, tolerating @oh-my-pi/pi-natives' Bun-targeted
 * loader. Its index.js runs `loadNative()` at import time using
 * `import.meta.dir`, which is a Bun-ism and `undefined` on Node — so a plain
 * `import("@oh-my-pi/pi-natives")` throws under Node. We try that first (it
 * works on Bun / future Node-compat releases), then fall back to requiring the
 * prebuilt platform addon directly, picking baseline vs modern by AVX2 support
 * exactly like the package's own loader does.
 *
 * Returns the render fn, or null if it can't be loaded. Callers decide whether
 * null is fatal (startup) or tolerable (per-render). The result is cached.
 */
async function resolveSnapcompactRenderer(): Promise<RenderSnapcompactPng | null> {
  if (snapcompactRendererCache !== undefined) return snapcompactRendererCache

  // Path 1: the package's normal entry (works on Bun).
  try {
    const mod = (await import("@oh-my-pi/pi-natives")) as {
      renderSnapcompactPng?: RenderSnapcompactPng
    }
    if (typeof mod.renderSnapcompactPng === "function") {
      snapcompactRendererCache = mod.renderSnapcompactPng
      return snapcompactRendererCache
    }
  } catch {
    // fall through to the direct-addon path
  }

  // Path 2: require the prebuilt platform binary directly, bypassing the
  // Bun-only loader. Only wired for linux-x64 (this container).
  if (process.platform === "linux" && process.arch === "x64") {
    const { createRequire } = await import("node:module")
    const req = createRequire(import.meta.url)
    const variant = detectAvx2() ? "modern" : "baseline"
    const order =
      variant === "modern"
        ? ["pi_natives.linux-x64-modern.node", "pi_natives.linux-x64-baseline.node"]
        : ["pi_natives.linux-x64-baseline.node"]
    for (const file of order) {
      try {
        const addon = req(`@oh-my-pi/pi-natives-linux-x64/${file}`) as {
          renderSnapcompactPng?: RenderSnapcompactPng
        }
        if (typeof addon.renderSnapcompactPng === "function") {
          snapcompactRendererCache = addon.renderSnapcompactPng
          return snapcompactRendererCache
        }
      } catch {
        // try the next variant
      }
    }
  }

  snapcompactRendererCache = null
  return snapcompactRendererCache
}

/**
 * Eager startup init. Call during boot when snapcompact frames are the intended
 * deep-archive path. THROWS if the native renderer can't be loaded, so a broken
 * setup fails the service at startup rather than silently degrading later.
 */
export async function initSnapcompactRenderer(): Promise<void> {
  const render = await resolveSnapcompactRenderer()
  if (!render) {
    throw new Error(
      "snapcompact frames are enabled but the @oh-my-pi/pi-natives native renderer " +
        "could not be loaded (missing/incompatible prebuilt addon for " +
        `${process.platform}-${process.arch}). Fix the dependency or disable frame archiving.`,
    )
  }
  console.log("[compaction] snapcompact native renderer loaded")
}

/** Detect AVX2 support to pick the modern vs baseline prebuilt binary. */
function detectAvx2(): boolean {
  try {
    if (process.platform === "linux") {
      const cpuinfo = readFileSync("/proc/cpuinfo", "utf8")
      return /\bavx2\b/i.test(cpuinfo)
    }
  } catch {
    // conservative default below
  }
  return false
}

/** Frame width in px; height auto-hugs the rows the text uses. */
const SNAPCOMPACT_FRAME_SIZE = 1024

/**
 * The snapcompact bitmap backend — pixel-font frames a vision model reads back.
 * Renders the discarded transcript into a compact indexed-PNG frame via
 * @oh-my-pi/pi-natives' renderSnapcompactPng and appends it as an image message
 * the vision model can consult. If the native renderer isn't available it
 * declines (returns null) so the caller falls back to the next backend.
 */
export class SnapcompactFramesArchive implements DeepArchiveBackend {
  readonly name = "snapcompact-frames"
  async archive(discarded: Message[]): Promise<DeepArchiveResult | null> {
    if (discarded.length === 0) return null
    // Per-render path: tolerate a missing renderer (degrade to null → text
    // appendix). A genuinely broken setup would already have crashed at startup
    // via initSnapcompactRenderer(); this null here means "not the frames path".
    const render = await resolveSnapcompactRenderer()
    if (!render) return null

    const { text, truncated } = serializeDiscarded(discarded, DEEP_ARCHIVE_MAX_CHARS)
    if (!text) return null

    let pngBase64: string
    try {
      // renderSnapcompactPng returns the PNG as a base64 string.
      pngBase64 = await render(text, { size: SNAPCOMPACT_FRAME_SIZE, font: "5x8", variant: "sent" })
    } catch (err) {
      console.warn(`[compaction] snapcompact render failed (${(err as Error)?.message ?? err}); declining`)
      return null
    }
    if (!pngBase64) return null

    const note = `snapcompact-frames archive of ${discarded.length} msg(s)` +
      (truncated > 0 ? ` (${truncated.toLocaleString()} chars elided)` : "")
    const archiveMessage: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text:
            "[deep archive] A rendered frame of older turns that the summary above compressed. " +
            "Read it only when an exact detail matters; do not re-narrate it.",
        },
        { type: "image", data: pngBase64, mimeType: "image/png" },
      ],
      timestamp: Date.now(),
    }
    return { note, archiveMessage }
  }
}

/**
 * Tries each backend in order and returns the first that produces a result.
 * Used to prefer bitmap snapcompact frames on a vision model while keeping the
 * text appendix as a guaranteed fallback (e.g. if the native renderer is
 * unavailable or rendering fails).
 */
export class FirstAvailableArchive implements DeepArchiveBackend {
  readonly name: string
  constructor(private readonly backends: DeepArchiveBackend[]) {
    this.name = `first-available[${backends.map((b) => b.name).join(",")}]`
  }
  async archive(discarded: Message[]): Promise<DeepArchiveResult | null> {
    for (const backend of this.backends) {
      const result = await backend.archive(discarded).catch((err) => {
        console.warn(`[compaction] deep archive (${backend.name}) errored: ${(err as Error)?.message ?? err}`)
        return null
      })
      if (result) return result
    }
    return null
  }
}

/** Provider string → deep-archive backend. */
export function resolveDeepArchiveBackend(provider: string | undefined): DeepArchiveBackend {
  // Read from modelState so deep_archive swaps with the model preset at runtime.
  if (!modelState.deepArchive) return new NoopArchive()
  const p = (provider ?? "").toLowerCase()
  if (p.includes("openai") && REMOTE_COMPACTION_ENDPOINT) return new OpenAiRemoteArchive()
  // On a vision-capable model, prefer bitmap snapcompact frames (a rendered
  // frame is denser than text and the model can read it back), falling back to
  // the text appendix when the native renderer is unavailable or declines.
  if (modelState.primaryVision) {
    return new FirstAvailableArchive([new SnapcompactFramesArchive(), new TextAppendixArchive()])
  }
  return new TextAppendixArchive()
}

/**
 * Whether snapcompact bitmap frames are the intended deep-archive path for the
 * current config — i.e. resolveDeepArchiveBackend would build a frames backend.
 * Mirrors that function's branching so startup validation and runtime routing
 * never drift. When true, the boot path calls initSnapcompactRenderer() and a
 * load failure crashes startup.
 */
export function snapcompactFramesIntended(provider: string | undefined): boolean {
  if (!modelState.deepArchive) return false
  const p = (provider ?? "").toLowerCase()
  if (p.includes("openai") && REMOTE_COMPACTION_ENDPOINT) return false
  return modelState.primaryVision
}

/** Disabled deep archive. */
export class NoopArchive implements DeepArchiveBackend {
  readonly name = "noop"
  async archive(): Promise<DeepArchiveResult | null> {
    return null
  }
}
