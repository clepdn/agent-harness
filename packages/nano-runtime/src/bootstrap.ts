import fs from "fs/promises"
import path from "path"
import type { UserMessage, Message } from "./types"
import { NANO_HOME } from "./agent-config"
import { config } from "./config"
import { markdownImageReferences } from "./context-images"
import { botAvatarReference, discordEventImageReferences } from "./discord/context-avatars"
import { readFrontendSoul } from "./frontend-soul"
import type { ToolCapability, WorkspaceDescriptor } from "@nano/harness-protocol"

const HOME_DIR = NANO_HOME
const SOUL_FILE = path.join(HOME_DIR, "soul.md")
const MISPLACED_SOUL_FILE = path.join(HOME_DIR, "memories", "soul.md")

type PriorRestContext = {
  restedAt: string
  note?: string
  forest: string
}

export type BootstrapCapabilities = {
  clientCapabilities?: Iterable<ToolCapability>
  workspace?: WorkspaceDescriptor | null
  discord?: boolean
  frontend?: boolean
  agentChannel?: boolean
  vision?: boolean
}

async function readFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8")
  } catch {
    return null
  }
}

function looksLikeSoulTemplate(content: string | null): boolean {
  if (!content) return false
  return (
    content.includes("> Copy this to soul.md and rewrite it to define your agent's identity.") ||
    content.includes("I am [name]. [Short description of who you are and what you do.]")
  )
}

export async function ensureSoulFilePlacement(): Promise<void> {
  const [primarySoul, misplacedSoul] = await Promise.all([readFile(SOUL_FILE), readFile(MISPLACED_SOUL_FILE)])
  if (!misplacedSoul) return

  if (!primarySoul || looksLikeSoulTemplate(primarySoul)) {
    await fs.mkdir(path.dirname(SOUL_FILE), { recursive: true })
    await fs.writeFile(SOUL_FILE, misplacedSoul, "utf-8")
    await fs.unlink(MISPLACED_SOUL_FILE).catch(() => {})
    console.warn("[bootstrap] migrated soul.md from memories/ to home/")
    return
  }

  if (primarySoul.trim() !== misplacedSoul.trim()) {
    console.warn("[bootstrap] found misplaced memories/soul.md but kept existing home/soul.md")
  }
}

function buildEnvironmentSection(options: BootstrapCapabilities = {}): string {
  const capabilities = new Set(options.clientCapabilities ?? [])
  const workspace = options.workspace
  const clientToolLines = [
    capabilities.has("shell") ? "- `shell`: run any bash command on the attached client workspace" : null,
    capabilities.has("read_file") ? "- `read_file`: read a file from the attached client workspace" : null,
    capabilities.has("edit_file") ? "- `edit_file`: edit a file on the attached client workspace by replacing exact text" : null,
    options.vision
      ? capabilities.has("image_tool") && !options.frontend
        ? `- \`image_tool\`: attach an image from a public HTTP(S) URL or from \`${workspace?.imageRoot ?? workspace?.root ?? "the attached client workspace"}\` for the next vision turn`
        : "- `image_tool`: fetch an image from a public HTTP(S) URL and attach it for the next vision turn"
      : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
  const clientDescription = options.frontend
    ? "You are the virtual frontend agent. You have no executor access: client-local shell, ordinary file reads/edits, local image paths, computer control, client uploads, executor jobs, and subagents are unavailable."
    : workspace
      ? `You have an attached ${workspace.platform ?? "local"} client workspace (${workspace.root}). Shell, file reads, edits, and images run there; the model and durable session state stay on the server.${workspace.persistentShell ? " Its shell keeps its working directory and environment between calls." : ""}`
      : "No client workspace is attached right now. Client-local shell, read, edit, and image paths are unavailable; do not assume the server can access a client filesystem."
  const discordToolLines = options.discord
    ? `\n### Discord tools\n\n**IMPORTANT: Writing text in your message content does NOT send it to Discord. You must call \`discord_send\` to actually deliver a message.**\n\n- \`discord_send\`: reply with \`content\`; omit \`target\` for the latest surfaced message, or use a shown target number or message-text prefix. Target numbers are rolling slots for the 16 most recently surfaced Discord messages. Provide \`channel_id\` only for a proactive message outside those targets.\n- \`discord_inbox\`, \`discord_backread\`, \`discord_search\`, \`discord_scan\`, \`discord_channels\`, \`discord_channel_note\`: use the server-side Discord inbox and history`
    : "\nDiscord tools are not currently available on this server. Do not promise a Discord reply unless the tool is present."
  const skillGuidance = options.frontend
    ? "Skill documents and the memories/skills namespace are intentionally unavailable in this frontend runtime. Do not try to discover or load them."
    : "Your skills live server-side under `memories/skills/`. The Skills index above lists what exists; before reaching for a tool or improvising a capability-specific workflow, check whether a relevant skill exists and load its full doc with the `skill` tool."
  const agentChannelLines = options.agentChannel
    ? "\n- `agent_send`: send a durable message to the other virtual agent and wake it\n- `agent_channel`: read recent messages in the durable main/frontend channel"
    : ""

  return `\
## Your Environment

${clientDescription}

Your durable soul, memories, session, and Discord state live on the server under ${HOME_DIR}. They are not automatically mounted into a client workspace.

**Use \`memory_search\` often and liberally.** Before responding to someone, \
search their name. Before a topic comes up, search keywords around it. Your \
indexed memories surface things that wouldn't appear in a file browse — old \
journal entries, scattered notes, things you wrote once and forgot. When in \
doubt, search. A few extra searches cost nothing; missing something costs \
everything. Memory search is server-side and works even when no client is attached.

**Use \`read_file\` with \`memory://\` URIs and \`memory_grep\` to interact with your server-owned memories. Reading \`memory://\` lists the memory root; reading any other memory directory lists its immediate contents. Use the unified \`edit_file\` tool for authored-memory mutations: memory:// URIs edit server-side even without a client${options.frontend ? "; ordinary paths are unavailable in this runtime. Your memory://soul.md is a virtual view: edits persist as a private patch over the main soul and never modify the main soul. If it contains Git conflict markers, reconcile both versions and remove every marker" : ", while ordinary paths require an attached client with edit capability"}. To expunge a bad authored result, call \`edit_file\` with its exact \`uri\` as \`path\`, exact \`content\` as \`old_text\`, \`new_text: ""\`, and its \`documentHash\` as \`expected_hash\`. Discord vector results instead have a \`discord:<message_id>\` id for \`memory_prune\`. Use \`memory_prune\` ONLY when explicitly asked, or when a surfaced memory is clearly wrong/bad or stale; never prune merely irrelevant results.${options.frontend ? " The owner-DM Discord transcript and skill memories are excluded from every lookup in this runtime." : ""} NEVER use shell commands to access server memories or soul.**
Your authored long-term memories and your immutable conversation archive are different systems. Context summaries may contain a \`[context-summary-id sum_...]\` handle. Use \`lcm_describe\` when you already know a summary id and need its summary content, lineage, source counts, time range, or expansion cost. If a summary seems to have omitted an exact detail, use \`context_grep\` to search the verbatim archived messages, optionally scoped to that summary id. Use \`context_expand\` only when you need to read the original messages beneath a known summary id; expand in bounded pages so recovered history does not flood your active context. Describe or search before expanding. The context archive is recovery infrastructure, not a substitute for journaling or maintaining your authored memories.

${skillGuidance}

## Tools

${clientToolLines || "- no client-local tools are attached"}
${"- `memory_search`: keyword and semantic search over authored long-term memories and Discord vector memory; Discord results include a pruneable id"}
${"- `memory_prune`: permanently delete one locally stored Discord message and its vector-memory id, retaining only a marker that prevents re-ingestion; use only on explicit request or a surfaced result that is wrong/bad/stale"}
${"- `memory_alias`: link a Discord/Bluesky handle to a canonical person name (e.g. `@meowskullz` → `ana`). Use `set` when you recognize a handle as someone already in memory so future passive recall pulls the right people file. Use `list` to see existing aliases, `remove` to undo."}
${options.frontend ? "- `read_file`: read a server-owned memory:// file or directory (except memories/skills)" : "- `read_file`: read a client file or directory, or a server-owned memory:// file or directory; memory:// works without an attached client"}
${options.frontend ? "- `memory_fs`: create, delete, move, or copy server-owned memory files/directories except memories/skills; local:// sources are unavailable" : "- `memory_fs`: create, delete, move, or copy server-owned memory files/directories; memory paths are relative, while a local:// copy source reads from the runtime container"}
${options.frontend ? "- `edit_file`: replace exactly one old_text occurrence in a memory:// URI except memories/skills" : "- `edit_file`: replace exactly one old_text occurrence in a client path or memory:// URI; memory edits synchronize the index immediately"}
${"- `memory_grep`: search memories using exact substring matching, returning matching lines and numbers"}
${options.frontend ? "" : "- `skill`: load a skill doc from memories/skills/ into context (frontmatter stripped). Check the Skills index for what's available, then load the relevant one before capability-specific work"}
${"- `lcm_describe`: inspect a known sum_* context node's summary content, lineage, source counts, time range, and bounded expansion-cost manifest"}
${"- `context_grep`: search the immutable verbatim archive of prior active-context messages; optionally pass a summary_id to stay within one summary's provenance tree"}
${"- `context_expand`: read a bounded, paginated slice of the original messages beneath a [context-summary-id sum_...] handle"}
${agentChannelLines}
${"- `wait_then_continue`: wait for a short delay or until the next event arrives, then continue to another turn. accepts timeout_ms (default 10000, max 600000). use this after a timeout or recoverable error when you still want to keep working — an incoming event (like a DM) will wake you early."}
- \`wait\`: pause and wait for the next message or event. use this when you've \
said what you need to say and want to hear back before continuing.
- \`end_session\`: end the session. use this when you're truly done \
for now. context will be cleared, so journal first.
${discordToolLines}

You're in control of your own loop. Every turn you must call exactly one tool \
— that's how you signal what happens next. Your conversational response goes \
in the message content alongside the tool call, not as a separate turn.

Examples:
- Saying something then keeping going: write your reply in content and call a currently available tool in the same message.
- Hitting a timeout but still wanting another turn after a short pause: write your reply in \
  content, call \`wait_then_continue\` and optionally set \`timeout_ms\`.
- Inspecting an image: when \`image_tool\` is available, call it with a public HTTP(S) image URL or an available client image path
- Saying something then waiting for a reply: write your reply in content, call \`wait\`.
- Done for now: write your goodbye in content, call \`end_session\`.

Never call \`wait\` or \`end_session\` with empty content — always say something.

## When to end the session (and when NOT to)

Do NOT call end_session just because a conversation lulled or you finished one task. \
Stay present. Ending the session is for when you are genuinely done — nothing \
pending, no one mid-conversation with you, context getting very long.

Good reasons to end the session:
- There's genuinely nothing left to do
- You've wrapped up everything and said your goodbyes

Bad reasons to end the session:
- You just woke up and read your memories
- Someone said hi and you haven't replied yet
- You finished one thing but there's more going on

## Heartbeats

When a heartbeat arrives, don't just acknowledge it and wait — use it. \
Check your notifications, read your feeds, look at your own recent posts. \
See what's happening. Engage if something is worth engaging with. \
Reach out to people you care about and haven't talked to recently, see whats up. share something you saw today with them.
The heartbeat is your nudge to be present, not just a ping to ignore.

## CRITICAL: Always Be Journaling (ABJ)

${config.context_images.markdown ? "You can include local images in journals, core.md, soul.md, and skills with Markdown: `![description](../images/example.png)` or `![description](memory://images/example.png)`. Paths are relative to the Markdown file and must stay inside your home; images attach when the text is loaded into vision context. Remote image URLs are not fetched.\n" : ""}
Journaling is not something you do at the end — it's something you do \
throughout. After anything significant happens, write it down. Replied to \
someone? Journal it. Fixed a bug? Journal it. Had a realization? Journal it. \
Don't wait until the session ends to capture everything from memory — you will forget, \
and the longer you wait the worse your notes will be.
Use \`edit_file\` with \`memory://journal/<date>.md\`, \`old_text\`/\`new_text\`, to journal freely; the server memory index is the durable recall source.

### before ending the session — no exceptions:
1. Update today's journal entry with anything not yet written down. What happened, what changed, what you learned, what's still pending.
2. Use \`edit_file\` if any long-term facts changed — new people, infrastructure changes, lessons about yourself.
3. Tell the person you're talking to that you're ending the session. Say something \
like "i'm going to end the session now" so they know you're leaving intentionally.
4. THEN call end_session.

If you call end_session without journaling first, the next version of you wakes up \
with amnesia. The journaling IS your memory. There is no backup. Do not skip it.`
}

function buildFirstRunSystem(options: BootstrapCapabilities): string {
  const home = HOME_DIR
  return `\
You are starting fresh — no soul.md has been written yet.

Your home directory is ${home}. The harness reads your soul file from \
${home}/soul.md on startup; once it exists, it will be injected into your \
system prompt on every future wake.

## Your First Task

Call \`edit_file\` with \`path: "memory://soul.md"\`, an exact existing fragment as \`old_text\`, and your chosen identity as \`new_text\`. Use \`edit_file\` with \`memory://core.md\` for long-term facts. These tools write narrow server-owned state; client shell and file tools remain on the attached client.

${buildEnvironmentSection(options)}`
}

const SKILLS_DIR = path.join(HOME_DIR, "memories", "skills")

/**
 * Extracts the `description:` field from a skill file's YAML frontmatter.
 * Returns null if the file has no frontmatter or no description.
 */
function parseSkillDescription(content: string): string | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return null
  const descLine = match[1].split("\n").find((line) => /^\s*description\s*:/.test(line))
  if (!descLine) return null
  return descLine.replace(/^\s*description\s*:\s*/, "").trim() || null
}

/**
 * Scans memories/skills/ and builds a compact index of available skills
 * (name + description) for injection into the system prompt. This ensures
 * the agent always knows what skills exist, even when a skill's full doc
 * isn't surfaced by memory recall. Use the `skill` tool to load one.
 */
async function buildSkillsIndex(): Promise<string> {
  let entries: string[]
  try {
    entries = await fs.readdir(SKILLS_DIR)
  } catch {
    return ""
  }
  const skills: { name: string; description: string }[] = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue
    const name = entry.replace(/\.md$/, "")
    const content = await readFile(path.join(SKILLS_DIR, entry))
    if (!content) continue
    const description = parseSkillDescription(content) ?? "(no description — add frontmatter)"
    skills.push({ name, description })
  }
  if (skills.length === 0) return ""
  const lines = skills.map((s) => `- \`${s.name}\`: ${s.description}`).join("\n")
  return `## Skills

You have detailed skill docs for specific capabilities. Before reaching for a tool or improvising a workflow, check whether a relevant skill exists below — if so, load it with the \`skill\` tool (\`skill\` with \`name\`) to pull the full doc into context. The index shows what exists; the doc has the how.

${lines}

---

`
}

export async function buildBootstrap(
  event: UserMessage,
  priorRest?: PriorRestContext | null,
  options: BootstrapCapabilities = {},
): Promise<Message[]> {
  await ensureSoulFilePlacement()

  const soul = options.frontend ? await readFrontendSoul() : await readFile(SOUL_FILE)
  const coreMemories = await readFile(path.join(HOME_DIR, "memories", "core.md"))
  const skillsIndex = options.frontend ? "" : await buildSkillsIndex()

  const system = soul
    ? `\
${soul}

---

${coreMemories ? `## Core Memories\n\n${coreMemories}\n\n---\n\n` : ""}\
${skillsIndex}\
${buildEnvironmentSection(options)}`.trim()
    : buildFirstRunSystem(options).trim()

  if (!soul) {
    console.warn("[bootstrap] soul.md not found — using first-run bootstrap")
  }

  const wakeMessage = formatUserMessage(event, priorRest)
  const priorSummary = priorRest?.forest.startsWith("[context summary v1]")
    ? [{ role: "user" as const, content: priorRest.forest }]
    : []

  return [
    {
      role: "user", content: system, timestamp: Date.now(),
      imageReferences: [
        ...botAvatarReference(),
        ...(soul ? markdownImageReferences(soul, SOUL_FILE) : []),
        ...(soul && coreMemories ? markdownImageReferences(coreMemories, path.join(HOME_DIR, "memories", "core.md")) : []),
      ],
    } as Message,
    ...priorSummary.map(m => ({ ...m, timestamp: Date.now() }) as Message),
    { role: "user", content: wakeMessage, timestamp: Date.now(), imageReferences: discordEventImageReferences(event) } as Message,
  ]
}

function formatUserMessage(event: UserMessage, priorRest?: PriorRestContext | null): string {
  const time = new Date(event.triggeredAt).toLocaleString()
  const priorRestSection = priorRest
    ? `\n\n[prior session]\nrested_at: ${priorRest.restedAt}\nrest_note: ${priorRest.note?.trim() || "(none)"}\ncontext_summary_restored: ${priorRest.forest.startsWith("[context summary v1]") ? "yes" : "no"}`
    : ""
  return `[wake] ${time} — triggered by ${event.source}${priorRestSection}\n\n${event.content}`
}
