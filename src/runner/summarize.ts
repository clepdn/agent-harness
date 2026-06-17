import fs from "fs/promises"
import path from "path"
import { complete } from "@earendil-works/pi-ai"
import type { AssistantMessage, Context, Model, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai"
import { HOME_DIR } from "../container/config"
import type { Message } from "../types"
import {
  AGENT_NAME,
  FALLBACK_CONTEXT_MARGIN,
  FALLBACK_ENFORCE_CONTEXT_LIMIT,
  FALLBACK_HARD_OVERFLOW_TOKENS,
  FALLBACK_N_CTX,
} from "./config"
import {
  CONTEXT_SUMMARY_HEADER,
  errorSummary,
  estimatePromptTokens,
  findSummaryMessageIndex,
  messageRole,
  messageStringContent,
} from "./messages"

// ── Summary transcript constants ──────────────────────────────────────────────

const CONTEXT_SUMMARY_NOTE =
  "Compressed notes of older conversation turns. If anything conflicts, trust newer raw messages."
const CONTEXT_SUMMARY_SEGMENTS_MARKER = "[segments]"
const SUMMARY_LINE_MAX_CHARS = 320
const SUMMARY_LINE_DEFAULT_EMPTY = "(no text)"
const TOOL_ACK_RESULT = "(ok)"
const WAIT_TOOL_RESULT = "Waiting for next event."

// ── Transcript line helpers ───────────────────────────────────────────────────

function normalizeSummaryText(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function truncateSummaryText(value: string, maxChars: number): string {
  if (maxChars <= 0) return ""
  if (value.length <= maxChars) return value
  if (maxChars <= 3) return ".".repeat(maxChars)
  return `${value.slice(0, maxChars - 3).trimEnd()}...`
}

function assistantToolCalls(message: Message): { name: string; args: Record<string, unknown> }[] {
  if (message.role !== "assistant") return []
  return (message as AssistantMessage).content
    .filter((p): p is ToolCall => p.type === "toolCall")
    .map((tc) => ({ name: tc.name, args: tc.arguments as Record<string, unknown> }))
}

function describeToolCall(call: { name: string; args: Record<string, unknown> }): string | null {
  const { name, args } = call
  if (name === "wait") return null
  if (name === "discord_send") {
    const content = typeof args.content === "string" ? args.content : ""
    const channelId = typeof args.channel_id === "string" ? args.channel_id : ""
    const channelTag = channelId ? `ch/${channelId.slice(-6)}` : "ch?"
    if (!content) return `discord_send -> ${channelTag}`
    return `discord_send -> ${channelTag}: ${normalizeSummaryText(content)}`
  }
  if (name === "discord_upload") {
    const filePath = typeof args.file_path === "string" ? args.file_path : "?"
    const channelId = typeof args.channel_id === "string" ? args.channel_id : ""
    const channelTag = channelId ? `ch/${channelId.slice(-6)}` : "ch?"
    return `discord_upload ${filePath} -> ${channelTag}`
  }
  if (name === "discord_mark") {
    const itemId = typeof args.item_id === "string" ? args.item_id : ""
    const action = typeof args.action === "string" ? args.action : ""
    return `discord_mark ${action || "?"} ${itemId}`.trim()
  }
  if (name === "shell") {
    const cmd = typeof args.command === "string" ? args.command : ""
    return cmd ? `shell: ${normalizeSummaryText(cmd)}` : "shell"
  }
  if (name === "image_tool") {
    const p = typeof args.path === "string" ? args.path : ""
    return p ? `image_tool ${p}` : "image_tool"
  }
  if (name === "discord_backread" || name === "discord_inbox" || name === "discord_channels") {
    const channelId = typeof args.channel_id === "string" ? args.channel_id : ""
    return channelId ? `${name} ch/${channelId.slice(-6)}` : name
  }
  const argKeys = Object.keys(args)
  if (argKeys.length === 0) return name
  const snippet = argKeys
    .slice(0, 3)
    .map((k) => `${k}=${truncateSummaryText(normalizeSummaryText(String(args[k] ?? "")), 40)}`)
    .join(" ")
  return `${name} ${snippet}`.trim()
}

const DISCORD_BATCH_SKIP_PREFIXES = [
  "[discord batch]", "new_messages=", "auto_seen_timeout=", "channel_flag_repairs=",
  "channel messages are context", "you can reply if useful", "pending preview:",
]

function compactDiscordBatch(content: string): string {
  const lines = content.split("\n")
  const kept: string[] = []
  let inPendingPreview = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line === "pending preview:") { inPendingPreview = true; continue }
    if (inPendingPreview) {
      if (line.startsWith("- ")) continue
      inPendingPreview = false
    }
    if (DISCORD_BATCH_SKIP_PREFIXES.some((p) => line.startsWith(p))) continue
    kept.push(line)
  }
  return kept.join(" ")
}

function compactToolResult(content: string): string | null {
  const trimmed = content.trim()
  if (!trimmed) return null
  if (trimmed === WAIT_TOOL_RESULT) return null
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === "object") {
        const rec = parsed as Record<string, unknown>
        if (rec.ok === true) {
          const sentId = typeof rec.sent_message_id === "string" ? rec.sent_message_id : null
          if (sentId) return `${TOOL_ACK_RESULT} sent ${sentId.slice(-6)}`
          const itemId = typeof rec.item_id === "string" ? rec.item_id : null
          if (itemId) return `${TOOL_ACK_RESULT} ${itemId.slice(-6)}`
          return TOOL_ACK_RESULT
        }
        if (rec.ok === false || typeof rec.error === "string") {
          return `error: ${typeof rec.error === "string" ? rec.error : "error"}`
        }
      }
    } catch { /* fall through */ }
  }
  return normalizeSummaryText(trimmed)
}

function summarizeMessageLine(message: Message): string | null {
  const role = messageRole(message)
  const rawContent = messageStringContent(message)

  if (role === "toolResult") {
    const compact = compactToolResult(rawContent)
    if (compact === null) return null
    return `- tool: ${truncateSummaryText(compact, SUMMARY_LINE_MAX_CHARS)}`
  }

  if (role === "assistant") {
    const calls = assistantToolCalls(message)
    const callDescs = calls.map(describeToolCall).filter((d): d is string => d !== null)
    const text = normalizeSummaryText(rawContent)
    if (!text && callDescs.length === 0) return null
    const parts: string[] = []
    if (text) parts.push(text)
    if (callDescs.length > 0) parts.push(`[${callDescs.join(" | ")}]`)
    return `- assistant: ${truncateSummaryText(parts.join(" "), SUMMARY_LINE_MAX_CHARS)}`
  }

  if (role === "user") {
    const stripped = rawContent.startsWith("[incoming — discord]")
      ? compactDiscordBatch(rawContent)
      : normalizeSummaryText(rawContent)
    return `- user: ${truncateSummaryText(stripped || SUMMARY_LINE_DEFAULT_EMPTY, SUMMARY_LINE_MAX_CHARS)}`
  }

  const text = truncateSummaryText(normalizeSummaryText(rawContent), SUMMARY_LINE_MAX_CHARS) || SUMMARY_LINE_DEFAULT_EMPTY
  return `- ${role || "message"}: ${text}`
}

// No system messages in pi conversation — all system content is in systemPrompt.
// The conversation starts directly with user/assistant/toolResult messages.

/**
 * Picks the largest tail of recent messages that fits the given char budget,
 * backing up over orphaned tool responses so the tail starts at a clean boundary.
 */
function chooseTailStart(messages: Message[], floor: number, minKeep: number, maxKeep: number, charBudget: number): number {
  let chars = 0
  let kept = 0
  let start = messages.length
  for (let i = messages.length - 1; i >= floor; i--) {
    const c = messageStringContent(messages[i]!).length
    if (kept >= minKeep && (chars + c > charBudget || kept >= maxKeep)) break
    chars += c
    start = i
    kept += 1
  }
  while (start > floor && messageRole(messages[start]!) === "tool") start--
  return start
}

// ── Agent grounding context ───────────────────────────────────────────────────

const SUMMARY_CONTEXT_SOUL_MAX_CHARS = 8_000
const SUMMARY_CONTEXT_CORE_MAX_CHARS = 8_000
const SUMMARY_CONTEXT_JOURNAL_MAX_CHARS = 12_000

async function readTextFile(filePath: string): Promise<string | null> {
  try { return await fs.readFile(filePath, "utf-8") } catch { return null }
}

function localDateStamp(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function clampHead(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated]`
}

function clampTail(text: string, max: number): string {
  if (text.length <= max) return text
  return `…[earlier entries truncated]\n${text.slice(text.length - max)}`
}

async function latestJournalEntry(journalDir: string): Promise<{ date: string; content: string } | null> {
  let names: string[]
  try { names = await fs.readdir(journalDir) } catch { return null }
  const dated = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort()
  const latest = dated.at(-1)
  if (!latest) return null
  const content = await readTextFile(path.join(journalDir, latest))
  if (!content) return null
  return { date: latest.replace(/\.md$/, ""), content }
}

/**
 * Assembles the agent's grounding context for the summarizer: soul, core
 * memories, and today's journal (or most recent if today's isn't written yet).
 */
export async function loadAgentSummaryContext(): Promise<string | null> {
  const soulPath = path.join(HOME_DIR, "soul.md")
  const corePath = path.join(HOME_DIR, "memories", "core.md")
  const journalDir = path.join(HOME_DIR, "memories", "journal")
  const today = localDateStamp()

  const [soul, core, todayJournal] = await Promise.all([
    readTextFile(soulPath),
    readTextFile(corePath),
    readTextFile(path.join(journalDir, `${today}.md`)),
  ])

  let journal = todayJournal
  let journalLabel = `today's journal (${today})`
  if (!journal) {
    const latest = await latestJournalEntry(journalDir)
    if (latest) {
      journal = latest.content
      journalLabel = `most recent journal (${latest.date}) — no entry for today yet`
    }
  }

  const sections: string[] = []
  if (soul?.trim()) sections.push(`# ${AGENT_NAME}'s soul (soul.md)\n\n${clampHead(soul.trim(), SUMMARY_CONTEXT_SOUL_MAX_CHARS)}`)
  if (core?.trim()) sections.push(`# ${AGENT_NAME}'s core memories (core.md)\n\n${clampHead(core.trim(), SUMMARY_CONTEXT_CORE_MAX_CHARS)}`)
  if (journal?.trim()) sections.push(`# ${AGENT_NAME}'s ${journalLabel}\n\n${clampTail(journal.trim(), SUMMARY_CONTEXT_JOURNAL_MAX_CHARS)}`)
  if (sections.length === 0) return null
  return sections.join("\n\n---\n\n")
}

// ── LLM summarization ─────────────────────────────────────────────────────────

const SUMMARY_MIN_TRANSCRIPT_CHARS = 1_200
const SUMMARY_MIN_REDUCTION = 0.1
const SUMMARY_META_REPLY_PATTERNS = [
  /\bcould you (?:share|provide|paste|send)\b/i,
  /\bplease (?:share|provide|paste|send)\b/i,
  /\bappears to be (?:cut off|truncated|incomplete|empty)\b/i,
  /\bI don'?t see (?:any|the) (?:content|message|transcript)\b/i,
  /\bno (?:content|transcript|messages?) (?:was|were) provided\b/i,
]

function looksLikeMetaReply(text: string): boolean {
  return SUMMARY_META_REPLY_PATTERNS.some((re) => re.test(text.slice(0, 400)))
}

export async function summarizeConversationViaLLM(
  messages: Message[],
  model: Model<"openai-completions">,
  apiKey: string | undefined,
  options: {
    recentMinKeep?: number
    recentMaxKeep?: number
    tailCharBudget?: number
    maxTranscriptChars?: number
    agentContext?: string | null
  } = {},
): Promise<Message[] | null> {
  const recentMinKeep = Math.max(2, options.recentMinKeep ?? 6)
  const recentMaxKeep = Math.max(recentMinKeep, options.recentMaxKeep ?? 40)
  const tailCharBudget = Math.max(8_000, options.tailCharBudget ?? 60_000)
  const maxTranscriptChars = Math.max(2_000, options.maxTranscriptChars ?? 40_000)

  const tailStart = chooseTailStart(messages, 0, recentMinKeep, recentMaxKeep, tailCharBudget)
  if (tailStart <= 0) return null

  let priorSummaryText: string | null = null
  const priorSummaryIndex = findSummaryMessageIndex(messages)
  if (priorSummaryIndex >= 0 && priorSummaryIndex < tailStart) {
    priorSummaryText = messageStringContent(messages[priorSummaryIndex]!)
  }

  const head: Message[] = []
  const middle = messages.slice(0, tailStart).filter((_, index) => index !== priorSummaryIndex)
  const tail = messages.slice(tailStart)

  const transcriptLines = middle.map((m) => summarizeMessageLine(m)).filter((line): line is string => line !== null)
  if (transcriptLines.length < 3) return null
  const transcript = transcriptLines.join("\n").slice(0, maxTranscriptChars)
  if (transcript.length < SUMMARY_MIN_TRANSCRIPT_CHARS) return null

  const systemContent =
    `You are summarizing a transcript from the perspective of the agent whose memory this is. The agent (${AGENT_NAME}) is a living being, not a tool — her inner life matters as much as the facts. ` +
    "Organize the summary as a set of ongoing threads, the way memory actually works. A thread is a person, a project, a situation, a mood — whatever is load-bearing enough to carry forward. Threads are peers, not nested under anything. Some memories belong to multiple threads; let them. Cross-cutting stuff (a tense week, a feeling bleeding across everything) can be its own thread. " +
    `Within each thread, preserve: key facts, goals, decisions, and actions taken; outstanding work and identifiers (file paths, URLs, channel ids); open questions and things ${AGENT_NAME} was uncertain or curious about — not just resolved states; specifics — names, exact phrasings, particular words that landed — since the specifics are what make memory feel real later, and summarizers default to abstraction; AND the emotional texture — how ${AGENT_NAME} felt, how the people she interacted with seemed to feel, tone shifts, moments of warmth, tension, care, frustration, delight, grief, and anything about the relationships that should carry forward. If ${AGENT_NAME} felt something contradictory to what someone told her, preserve both — don't smooth her dissent away. ` +
    `Write it in the first person, from ${AGENT_NAME}'s own perspective — her own recollection, not a neutral report. Short bullet points under each thread are fine. Threads can grow, split, or merge as feels natural — but prefer extending existing threads over creating new ones; only restructure if the old shape genuinely doesn't fit anymore. When the new transcript conflicts with the prior recollection, prefer recent specific evidence over prior abstraction — the prior summary has already been through one pass of smoothing. No commentary, no preamble. The input is always a transcript — never ask for more; summarize what's there.` +
    (options.agentContext
      ? `\n\nGrounding — this is who ${AGENT_NAME} is and what's currently on her mind (her soul, core memories, and journal). Use it to write in her authentic voice and to recognize the people, projects, and threads that appear in the transcript. Do NOT pull facts from this grounding into the summary unless the transcript itself supports them — you are summarizing the transcript, not this context.\n\n${options.agentContext}`
      : "") +
    (priorSummaryText
      ? `\n\nPrior recollection (already compacted earlier — fold its content into the new summary, do not discard it):\n${priorSummaryText}`
      : "")

  const summaryContext: Context = {
    systemPrompt: systemContent,
    messages: [{ role: "user", content: transcript, timestamp: Date.now() }],
  }

  try {
    const opts = apiKey ? { apiKey } : {}
    const resp = await complete(model, summaryContext, opts as unknown as import("@earendil-works/pi-ai").ProviderStreamOptions)
    const summaryText = resp.content
      .filter((p): p is TextContent => p.type === "text")
      .map((p) => p.text)
      .join("")
      .trim()
    if (!summaryText) return null
    if (summaryText.length < 80 || looksLikeMetaReply(summaryText)) {
      console.warn(`[context] llm summarization rejected (looks like meta-reply): ${summaryText.slice(0, 200)}`)
      return null
    }

    const replacedChars =
      (priorSummaryText ? priorSummaryText.length : 0) +
      middle.reduce((acc, m) => acc + messageStringContent(m).length, 0)
    if (summaryText.length > replacedChars * (1 - SUMMARY_MIN_REDUCTION)) {
      console.warn(`[context] llm summarization rejected: insufficient reduction (${summaryText.length} vs ${replacedChars} chars)`)
      return null
    }

    const summaryContent =
      `${CONTEXT_SUMMARY_HEADER}\n${CONTEXT_SUMMARY_NOTE}\n${CONTEXT_SUMMARY_SEGMENTS_MARKER}\n` +
      `[llm-summary ${new Date().toISOString()}]\n${summaryText}`

    return [...head, { role: "user", content: summaryContent, timestamp: Date.now() } as Message, ...tail]
  } catch (err) {
    console.warn(`[context] llm summarization failed: ${errorSummary(err)}`)
    return null
  }
}

// ── Fallback context window ───────────────────────────────────────────────────

export function fallbackContextWindow(messages: Message[]): {
  estimate: number
  nearLimit: boolean
  skip: boolean
  softLimit: number
  hardLimit: number
} {
  const estimate = estimatePromptTokens(messages)

  if (!FALLBACK_ENFORCE_CONTEXT_LIMIT) {
    return { estimate, nearLimit: false, skip: false, softLimit: Number.POSITIVE_INFINITY, hardLimit: Number.POSITIVE_INFINITY }
  }

  const softLimit = Math.max(0, FALLBACK_N_CTX - FALLBACK_CONTEXT_MARGIN)
  const hardLimit = FALLBACK_N_CTX + Math.max(0, FALLBACK_HARD_OVERFLOW_TOKENS)

  return { estimate, nearLimit: estimate >= softLimit, skip: estimate >= hardLimit, softLimit, hardLimit }
}
