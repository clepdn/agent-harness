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

import { writeMemory } from "../agent-state-tools"
import type { Message } from "../types"
import {
  DEEP_ARCHIVE_ENABLED,
  JOURNAL_BEFORE_COMPACTION,
  REMOTE_COMPACTION_ENDPOINT,
  REMOTE_COMPACTION_MODEL,
} from "./config"
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

/**
 * The snapcompact bitmap backend — pixel-font frames a vision model reads back.
 * Not yet available: it depends on oh-my-pi's native rasterizer
 * (renderSnapcompactPng) which has not been vendored into this tree.
 */
export class SnapcompactFramesArchive implements DeepArchiveBackend {
  readonly name = "snapcompact-frames"
  async archive(_discarded: Message[]): Promise<DeepArchiveResult | null> {
    console.warn(
      "[compaction] snapcompact-frames backend requested but the native renderer is not vendored; " +
        "falling back to no deep archive. Vendor @oh-my-pi/pi-natives to enable bitmap frames.",
    )
    return null
  }
}

/** Provider string → deep-archive backend. */
export function resolveDeepArchiveBackend(provider: string | undefined): DeepArchiveBackend {
  if (!DEEP_ARCHIVE_ENABLED) return new NoopArchive()
  const p = (provider ?? "").toLowerCase()
  if (p.includes("openai") && REMOTE_COMPACTION_ENDPOINT) return new OpenAiRemoteArchive()
  return new TextAppendixArchive()
}

/** Disabled deep archive. */
export class NoopArchive implements DeepArchiveBackend {
  readonly name = "noop"
  async archive(): Promise<DeepArchiveResult | null> {
    return null
  }
}
