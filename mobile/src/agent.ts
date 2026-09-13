// Port of the web agent loop (src/lib/agent.ts) plus the controller wiring.
// The architecture survives the platform change intact: the agent drives playback
// through read_aloud, which holds until the range ends or the user talks over it;
// transport commands run locally off partial transcripts; fact-check verdicts are
// spoken as soon as they exist. The model itself stays behind the deployed web
// app's /api routes — no keys in this bundle.
//
// What the phone adds: the library. The shared tools only know the open document;
// the ones declared here browse, open, file and close documents, and are sent to
// the server with every request alongside the guidance for using them.
import { useStore } from './store'
import { tts, voice } from './providers'
import { apiJson, apiBase } from './settings'
import {
  addHighlight,
  closeDocument,
  library,
  moveDocument,
  openDocument,
  positionChanged,
  removeHighlight,
} from './session'
import type { Highlight, LibraryDoc, Location } from './types'

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
type Msg = { role: 'user' | 'assistant'; content: string | Block[] }

const MAX_TURNS = 12
// The conversation outlives any one document now, so it needs a ceiling.
const TRIM_ABOVE = 40
const TRIM_TO = 30

let messages: Msg[] = []
let running = false
let pending: string | null = null
let awaitingWords = false
let greeted = false // the library hello happens once per app session

let counter = 0
const newId = () => `m-${Date.now()}-${++counter}`

/** Forget the conversation. The UI calls this on sign-out. */
export function resetConversation() {
  messages = []
  pending = null
  greeted = false
}

/** Patch a synthetic result under every orphaned tool_use before sending. */
function repair(msgs: Msg[]): Msg[] {
  const out: Msg[] = []
  for (const m of msgs) {
    const prev = out[out.length - 1]
    if (prev?.role === 'assistant' && Array.isArray(prev.content)) {
      const unanswered = prev.content
        .filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
        .filter(
          (call) =>
            !(m.role === 'user' && Array.isArray(m.content) &&
              m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === call.id)),
        )
      if (unanswered.length > 0) {
        const results: Block[] = unanswered.map((call) => ({
          type: 'tool_result', tool_use_id: call.id,
          content: '[Interrupted — the app was closed before this finished.]',
        }))
        if (m.role === 'user') {
          m.content = [...results, ...(typeof m.content === 'string' ? [{ type: 'text', text: m.content } as Block] : m.content)]
        } else {
          out.push({ role: 'user', content: results })
        }
      }
    }
    out.push(m)
  }
  const tail = out[out.length - 1]
  if (tail?.role === 'assistant' && Array.isArray(tail.content)) {
    const calls = tail.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
    if (calls.length > 0) {
      out.push({
        role: 'user',
        content: calls.map((call) => ({
          type: 'tool_result', tool_use_id: call.id,
          content: '[Interrupted — the app was closed before this finished.]',
        })),
      })
    }
  }
  return out
}

/**
 * Keep the transcript bounded. Drops the oldest messages once it grows past
 * TRIM_ABOVE, then makes the head valid again: the first message must be from
 * the user, and a tool_result whose tool_use was just dropped has to go too.
 */
function trim(msgs: Msg[]): Msg[] {
  let out = msgs.length > TRIM_ABOVE ? msgs.slice(-TRIM_TO) : msgs
  out = repair(out)
  while (out.length > 0) {
    const head = out[0]
    if (head.role !== 'user') { out = out.slice(1); continue }
    if (Array.isArray(head.content)) {
      const kept = head.content.filter((b) => b.type !== 'tool_result')
      if (kept.length === 0) { out = out.slice(1); continue }
      head.content = kept
    }
    break
  }
  return out
}

// ---- context ----

const minutes = (d: LibraryDoc) => (d.wordCount ? `~${Math.max(1, Math.round(d.wordCount / 230))} min` : null)
const percent = (d: LibraryDoc) => (d.readingProgress != null ? `${Math.round(d.readingProgress * 100)}% read` : null)

/** One library row the way the model sees it: `[id] Title — Author (category, ~N min, P% read)`. */
function row(d: LibraryDoc, withProgress: boolean): string {
  const meta = [d.category, minutes(d), withProgress ? percent(d) : null].filter(Boolean).join(', ')
  return `[${d.id}] ${d.title}${d.author ? ` — ${d.author}` : ''}${meta ? ` (${meta})` : ''}`
}

const byRecent = (a: LibraryDoc, b: LibraryDoc) => (a.updatedAt < b.updatedAt ? 1 : -1)

const LOCATION_NAMES: Record<Location, string> = { new: 'inbox', later: 'later', archive: 'archive', feed: 'feed' }

function libraryCounts(docs: LibraryDoc[]): string {
  const n = (loc: Location) => docs.filter((d) => d.location === loc).length
  return `The library has ${n('new')} in the inbox, ${n('later')} saved for later, ${n('archive')} archived.`
}

function chapterTitleAt(paragraph: number): string | null {
  const s = useStore.getState()
  const p = s.paragraphs[paragraph]
  const title = p ? s.doc?.chapters[p.chapterIndex]?.title : undefined
  return title && s.doc && s.doc.chapters.length > 1 ? title : null
}

function buildContext() {
  const s = useStore.getState()
  if (!s.doc) {
    // library mode: the reader is browsing by voice; give the model enough to act on without a tool call
    const showing = s.library.filter((d) => d.location === s.libraryLocation).sort(byRecent)
    const lines = [
      libraryCounts(s.library),
      `The ${LOCATION_NAMES[s.libraryLocation]} tab is showing.`,
      s.libraryQuery.trim() ? `The search box says "${s.libraryQuery.trim()}".` : null,
      showing.length > 0
        ? `Most recent in the ${LOCATION_NAMES[s.libraryLocation]} tab:\n${showing.slice(0, 15).map((d) => row(d, false)).join('\n')}`
        : `Nothing in the ${LOCATION_NAMES[s.libraryLocation]} tab.`,
      'Use list_library or search_library for more.',
    ].filter(Boolean)
    return {
      title: '(no document open — the reader is browsing their library)',
      totalParagraphs: 0,
      currentParagraph: 0,
      chapters: [],
      rate: s.rate,
      nearbyText: '',
      extra: lines.join('\n'),
    }
  }
  const cur = Math.min(s.currentParagraph, Math.max(0, s.paragraphs.length - 1))
  const from = Math.max(0, cur - 2)
  const to = Math.min(s.paragraphs.length - 1, cur + 1)
  let n = 0
  const chapters = s.doc.chapters.map((ch) => {
    const startsAt = n
    n += ch.paragraphs.length
    return { title: ch.title, startsAt }
  })
  return {
    title: s.doc.title,
    totalParagraphs: s.paragraphs.length,
    currentParagraph: cur,
    chapters,
    rate: s.rate,
    nearbyText: s.paragraphs
      .slice(from, to + 1)
      .map((p, i) => `[${from + i}] ${p.text}`)
      .join('\n\n'),
    extra: `${libraryCounts(s.library)} The reader can ask to go back to the library.`,
  }
}

// ---- shared tools (declared on the server) ----

async function playRange(from: number, to: number): Promise<'completed' | 'stopped'> {
  const s = useStore.getState()
  tts.setParagraphs(s.paragraphs.map((p) => p.text))
  tts.setRate(s.rate)
  useStore.setState({ agentState: 'reading' })
  const outcome = await tts.playFrom(from, to)
  useStore.setState({ agentState: running ? 'thinking' : 'idle' })
  return outcome
}

async function readAloud(input: Record<string, unknown>): Promise<string> {
  const s = useStore.getState()
  if (s.paragraphs.length === 0) return 'No document is loaded.'
  const last = s.paragraphs.length - 1
  const clamp = (n: number) => Math.max(0, Math.min(last, n))
  const from = Number.isInteger(input.from) ? clamp(input.from as number) : clamp(s.currentParagraph)
  const to = Number.isInteger(input.to) ? clamp(input.to as number) : last
  const outcome = await playRange(from, to)
  const stoppedAt = tts.currentIndex
  return outcome === 'completed'
    ? `Read paragraphs ${from} through ${to}. Position is now paragraph ${Math.min(to + 1, last)}.`
    : `The user interrupted at paragraph ${stoppedAt}, which reads: "${s.paragraphs[stoppedAt]?.text ?? ''}"`
}

interface FactCheckResult {
  verdict: string
  summary: string
  spokenSummary: string
  sources: { title: string; url: string }[]
}

/**
 * /api/factcheck speaks NDJSON. React Native's fetch has no streaming body, so the
 * per-field early speak the web does is off the table — await the whole thing and
 * speak the verdict once. Still one round-trip.
 */
async function factCheck(input: Record<string, unknown>): Promise<string> {
  const claim = String(input.claim ?? '')
  const res = await fetch(`${apiBase}/api/factcheck`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passage: claim }),
  })
  if (!res.ok) return `The fact check failed (${res.status}).`
  const lines = (await res.text()).split('\n').filter(Boolean)
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { type: string; result?: FactCheckResult; error?: string }
      if (parsed.type === 'done' && parsed.result) {
        const r = parsed.result
        useStore.getState().pushChat({ id: newId(), role: 'assistant', text: `${r.verdict}: ${r.summary}` })
        useStore.setState({ agentState: 'speaking' })
        await tts.speak(r.spokenSummary)
        return `[Already read aloud to the user, verbatim: "${r.spokenSummary}". Add nothing unless the user asked something this does not answer.]`
      }
      if (parsed.type === 'error') return `The fact check failed: ${parsed.error}`
    } catch { /* delta lines and partial JSON — skip */ }
  }
  return 'The fact check returned nothing usable.'
}

function findInDocument(input: Record<string, unknown>): string {
  const terms = String(input.query ?? '').toLowerCase().match(/[a-z0-9']+/g)
  if (!terms?.length) return 'No query given.'
  const hits = useStore
    .getState()
    .paragraphs.map((p, i) => {
      const text = p.text.toLowerCase()
      return { i, text: p.text, score: terms.filter((t) => text.includes(t)).length }
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 6)
  if (hits.length === 0) return `Nothing in the document matches "${input.query}".`
  return hits.map((h) => `[${h.i}] ${h.text.slice(0, 180)}`).join('\n')
}

/** The session anchors it, paints it, persists it and writes it to Readwise in the background. */
async function highlight(input: Record<string, unknown>): Promise<string> {
  const s = useStore.getState()
  const text = String(input.text ?? '').trim()
  if (!text) return 'No passage was given to highlight.'
  const last = Math.max(0, s.paragraphs.length - 1)
  const near = Number.isInteger(input.anchor)
    ? Math.max(0, Math.min(last, input.anchor as number))
    : Math.min(last, s.currentParagraph)
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : undefined
  const h = await addHighlight({ text, note, near })
  const where = h.anchor
    ? `anchored at paragraph ${h.anchor.paragraph}`
    : 'the exact passage could not be located in the text, so it was saved as text'
  return `Highlighted in the book and being saved to Readwise; ${where}.`
}

function setSpeed(input: Record<string, unknown>): string {
  const rate = Math.max(0.5, Math.min(3, Number(input.rate) || 1))
  useStore.getState().setRate(rate)
  tts.setRate(rate)
  return `Playback speed is now ${rate}x.`
}

// ---- client tools (declared here, sent with every request) ----

const LOCATIONS: Location[] = ['new', 'later', 'archive']
const locationSchema = {
  type: 'string',
  enum: LOCATIONS,
  description: 'Which shelf: "new" is the inbox, "later" is saved for later, "archive" is done with.',
}

export const CLIENT_TOOLS = [
  {
    name: 'list_library',
    description:
      'List the documents on one shelf of the library, newest first, as `[id] Title — Author (category, ' +
      'length, progress)`. Defaults to the shelf the reader is looking at. Use it for "what\'s new", ' +
      '"what have I saved for later", "what\'s in my inbox". Never read the ids aloud.',
    inputSchema: { type: 'object', properties: { location: locationSchema } },
  },
  {
    name: 'search_library',
    description:
      'Find documents in the library by title, author, or topic — "the Hemingway one", "that piece ' +
      'about sleep". Spoken queries are loose; pass the words the reader used. Returns the best ' +
      'matches in the same `[id] Title — Author (...)` shape. Never read the ids aloud.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Title, author, or topic words.' } },
      required: ['query'],
    },
  },
  {
    name: 'open_document',
    description:
      'Open a document from the library by id and pick up where the reader left off. Closes whatever ' +
      'was open. The result gives the position; call read_aloud in the same turn to start reading ' +
      'from there. Fails with a spoken-ready reason when the document has no readable text.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The id from list_library or search_library.' } },
      required: ['id'],
    },
  },
  {
    name: 'close_document',
    description:
      'Put the open document away and show the library — "go back to the library", "close this", ' +
      '"I\'m done with this one". The position is remembered.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'move_document',
    description:
      'File a document on another shelf — "archive that", "save it for later", "put it back in the ' +
      'inbox". Omit `id` to mean the open document.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id. Defaults to the open document.' },
        location: locationSchema,
      },
      required: ['location'],
    },
  },
  {
    name: 'list_highlights',
    description:
      'List the highlights in the open document — "what have I highlighted", "read me my notes". ' +
      'Returns `[id] "text" (paragraph N) — note`. Never read the ids aloud.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'remove_highlight',
    description: 'Delete one highlight by id, here and in Readwise — "remove that highlight", "undo that".',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The id from list_highlights.' } },
      required: ['id'],
    },
  },
]

export const CLIENT_SYSTEM = `The library:
- When no document is open, the reader is browsing their library by voice. Find what they ask for with search_library (or list_library for "what's new", "what have I saved"), then open it with open_document; reading picks up where they left off, so call read_aloud right after.
- If several documents match, say the top two or three titles in one breath and ask which. If one clearly matches, just open it.
- Never read ids aloud. Titles and authors only.
- "Archive that", "save it for later", "put it back in the inbox" are move_document. "Go back to the library", "close this", "I'm done" are close_document.
- When a document has no readable text — a PDF, a video — say so in a few words and offer the next match.
- Highlights are painted in the book and synced to Readwise; a short confirmation is enough. "What have I highlighted" is list_highlights.`

const asLocation = (v: unknown): Location | null => (LOCATIONS.includes(v as Location) ? (v as Location) : null)

function listLibrary(input: Record<string, unknown>): string {
  const location = asLocation(input.location) ?? useStore.getState().libraryLocation
  const docs = library().inLocation(location).sort(byRecent).slice(0, 20)
  if (docs.length === 0) return `Nothing on the ${LOCATION_NAMES[location]} shelf.`
  return docs.map((d) => row(d, true)).join('\n')
}

function searchLibrary(input: Record<string, unknown>): string {
  const query = String(input.query ?? '').trim()
  if (!query) return 'No query given.'
  const docs = library().search(query)
  if (docs.length === 0) return `Nothing in the library matches "${query}".`
  return docs.map((d) => row(d, true)).join('\n')
}

async function openDoc(input: Record<string, unknown>): Promise<string> {
  const id = String(input.id ?? '').trim()
  if (!id) return 'No document id given.'
  try {
    const { doc, libraryDoc, position } = await openDocument(id)
    const total = doc.chapters.reduce((n, ch) => n + ch.paragraphs.length, 0)
    const chapter = chapterTitleAt(position)
    return (
      `Opened "${doc.title}"${libraryDoc.author ? ` by ${libraryDoc.author}` : ''}. ` +
      `${total} paragraphs in ${doc.chapters.length} chapters. ` +
      `Position: paragraph ${position}${chapter ? ` (chapter "${chapter}")` : ''}. Call read_aloud to continue from there.`
    )
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

async function closeDoc(): Promise<string> {
  await closeDocument()
  return 'The document is closed; the library is showing.'
}

async function moveDoc(input: Record<string, unknown>): Promise<string> {
  const location = asLocation(input.location)
  if (!location) return 'No such shelf. Use "new" (the inbox), "later", or "archive".'
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : useStore.getState().libraryDoc?.id
  if (!id) return 'No document id given and nothing is open.'
  try {
    const doc = await moveDocument(id, location)
    const dest = location === 'new' ? 'the inbox' : location === 'later' ? 'later' : 'the archive'
    return `Moved "${doc.title}" to ${dest}.`
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

function listHighlights(): string {
  const s = useStore.getState()
  if (!s.doc) return 'No document is open.'
  const live = s.highlights.filter((h) => h.pending !== 'delete')
  if (live.length === 0) return 'No highlights yet.'
  return live
    .map((h: Highlight) => {
      const text = h.text.length > 160 ? `${h.text.slice(0, 160)}…` : h.text
      const where = h.anchor ? `paragraph ${h.anchor.paragraph}` : 'not located in the text'
      return `[${h.id}] "${text}" (${where})${h.note ? ` — ${h.note}` : ''}`
    })
    .join('\n')
}

async function removeHl(input: Record<string, unknown>): Promise<string> {
  const id = String(input.id ?? '').trim()
  if (!useStore.getState().highlights.some((h) => h.id === id)) return 'No highlight with that id.'
  await removeHighlight(id)
  return 'Removed the highlight.'
}

async function runTool(block: Extract<Block, { type: 'tool_use' }>): Promise<Block> {
  let content: string
  try {
    switch (block.name) {
      case 'read_aloud': content = await readAloud(block.input); break
      case 'fact_check': content = await factCheck(block.input); break
      case 'find_in_document': content = findInDocument(block.input); break
      case 'set_speed': content = setSpeed(block.input); break
      case 'highlight': content = await highlight(block.input); break
      case 'list_library': content = listLibrary(block.input); break
      case 'search_library': content = searchLibrary(block.input); break
      case 'open_document': content = await openDoc(block.input); break
      case 'close_document': content = await closeDoc(); break
      case 'move_document': content = await moveDoc(block.input); break
      case 'list_highlights': content = listHighlights(); break
      case 'remove_highlight': content = await removeHl(block.input); break
      default: content = `Unknown tool: ${block.name}`
    }
  } catch (e) {
    // a tool that throws (not signed in, say) is a result for the model, not the end of the turn
    content = `The tool failed: ${e instanceof Error ? e.message : String(e)}`
  }
  return { type: 'tool_result', tool_use_id: block.id, content }
}

// ---- fast-path commands (verbatim from the web) ----

const PAUSE = /^(pause|stop|stop reading|quiet|be quiet|shush|hold on|hold up|hang on|wait|wait up|wait a (?:sec|second|minute)|one sec|one second|just a sec|give me a sec)$/
const RESUME = /^(resume|resume reading|unpause|continue|continue reading|keep going|keep reading|go on|carry on|go ahead|play|read|start|start reading|read it|keep on going)$/
const FASTER = /^(faster|go faster|speed up|speed it up|a (?:bit|little) faster)$/
const SLOWER = /^(slower|go slower|slow down|slow it down|a (?:bit|little) slower)$/
const NUMERIC_RATE = /^(?:go |set (?:the )?speed to )?(\d(?:\.\d+)?)\s*(?:x|times)(?: speed)?$/
const NAMED_RATES: Record<string, number> = {
  'normal speed': 1, 'regular speed': 1, normal: 1, 'back to normal': 1,
  'one x': 1, 'one and a half x': 1.5, 'two x': 2, 'three x': 3,
  'half speed': 0.5, 'double speed': 2,
}

const normalize = (text: string) => text.toLowerCase().replace(/[.!,?]+$/, '').trim()

type FastResult = { chat: string; note: string }

function matchFast(text: string): (() => FastResult) | null {
  const t = normalize(text)
  if (t.split(/\s+/).length > 6) return null

  if (PAUSE.test(t)) {
    return () => {
      tts.pause()
      return { chat: 'Paused.', note: 'Paused playback.' }
    }
  }

  if (RESUME.test(t) && !running) {
    const s = useStore.getState()
    if (s.paragraphs.length === 0) return null
    const from = Math.min(s.currentParagraph, s.paragraphs.length - 1)
    return () => {
      void playRange(from, useStore.getState().paragraphs.length - 1)
      return { chat: 'Reading.', note: `Resumed reading from paragraph ${from}.` }
    }
  }

  const named = NAMED_RATES[t]
  const numeric = t.match(NUMERIC_RATE)
  let rate: number | null = null
  if (FASTER.test(t)) rate = useStore.getState().rate + 0.25
  else if (SLOWER.test(t)) rate = useStore.getState().rate - 0.25
  else if (typeof named === 'number') rate = named
  else if (numeric) rate = Number(numeric[1])
  if (rate != null) {
    const r = rate
    return () => {
      const note = setSpeed({ rate: r })
      return { chat: `${useStore.getState().rate}x.`, note }
    }
  }

  return null
}

const fastCommand = (text: string): FastResult | null => matchFast(text)?.() ?? null

// ---- turn loop ----

let listenTimer: ReturnType<typeof setTimeout> | null = null
const restState = () => (running ? ('thinking' as const) : ('idle' as const))

export function beginUtterance() {
  awaitingWords = true
  tts.pause()
  useStore.setState({ agentState: 'listening' })
  if (listenTimer) clearTimeout(listenTimer)
  listenTimer = setTimeout(() => {
    awaitingWords = false
    if (useStore.getState().agentState === 'listening') useStore.setState({ agentState: restState() })
  }, 5000)
}

let handledEarly: { text: string; at: number; chatId: string | null } | null = null
const EARLY_DEDUP_WINDOW = 6000

export function sayInterim(text: string) {
  const t = normalize(text)
  if (!t || !matchFast(t)) return
  if (handledEarly && Date.now() - handledEarly.at < EARLY_DEDUP_WINDOW) return
  handledEarly = { text: t, at: Date.now(), chatId: null }
  handledEarly.chatId = say(text)
}

export function say(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const early = handledEarly
  handledEarly = null
  if (early && Date.now() - early.at < EARLY_DEDUP_WINDOW) {
    const n = normalize(trimmed)
    if ((n === early.text || n.startsWith(`${early.text} `)) && matchFast(n)) {
      if (early.chatId) useStore.getState().updateChat(early.chatId, { text: trimmed })
      return early.chatId
    }
  }
  awaitingWords = false
  const chatId = newId()
  useStore.getState().pushChat({ id: chatId, role: 'user', text: trimmed })
  if (useStore.getState().agentState === 'listening') useStore.setState({ agentState: restState() })

  const fast = fastCommand(trimmed)
  if (fast) {
    useStore.getState().pushChat({ id: newId(), role: 'assistant', text: fast.chat })
    if (running) {
      const done = `${trimmed} [the app already did this: ${fast.note}]`
      pending = pending ? `${pending} ${done}` : done
    } else {
      messages.push({ role: 'user', content: trimmed })
      messages.push({ role: 'assistant', content: fast.note })
    }
    return chatId
  }

  if (running) {
    pending = pending ? `${pending} ${trimmed}` : trimmed
    tts.pause()
    return chatId
  }
  messages.push({ role: 'user', content: trimmed })
  void loop()
  return chatId
}

/**
 * The agent's first move on a screen. 'library' is the hello, once per app
 * session; 'document' is a document the reader opened by tapping (a voice-opened
 * one carries its own tool result), so the agent picks up reading unprompted.
 */
export function openingTurn(kind: 'library' | 'document') {
  if (kind === 'library') {
    if (running || greeted) return
    greeted = true
    messages.push({
      role: 'user',
      content: '[The reader is looking at their library and listening. Say hello in one short line and ask what they\'d like to read, or offer the newest item in the inbox by title.]',
    })
    void loop()
    return
  }
  const s = useStore.getState()
  if (!s.doc) return
  const total = s.paragraphs.length
  const position = Math.min(s.currentParagraph, Math.max(0, total - 1))
  const chapter = chapterTitleAt(position)
  const cue = `[The reader opened "${s.doc.title}" by hand. Position is paragraph ${position} of ${total}${chapter ? `, in chapter "${chapter}"` : ''}. Pick up reading from there.]`
  if (running) {
    // a tap mid-turn: the loop picks it up as the next thing the reader "said"
    pending = pending ? `${pending} ${cue}` : cue
    return
  }
  messages.push({ role: 'user', content: cue })
  void loop()
}

async function settle(ms = 3000) {
  const deadline = Date.now() + ms
  while (awaitingWords && !pending && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  awaitingWords = false
  if (useStore.getState().agentState === 'listening') useStore.setState({ agentState: 'thinking' })
}

async function loop() {
  running = true
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      messages = trim(messages)
      useStore.setState({ agentState: 'thinking' })
      const { content } = await apiJson<{ content: Block[] }>('/api/agent', {
        messages,
        context: buildContext(),
        clientTools: CLIENT_TOOLS,
        clientSystem: CLIENT_SYSTEM,
      })
      messages.push({ role: 'assistant', content })

      const spoken = content
        .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim()
      if (spoken) {
        useStore.getState().pushChat({ id: newId(), role: 'assistant', text: spoken })
        useStore.setState({ agentState: 'speaking' })
        await tts.speak(spoken)
      }

      const calls = content.filter(
        (b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use',
      )
      if (calls.length === 0) break

      const results: Block[] = []
      for (const call of calls) {
        results.push(
          pending
            ? { type: 'tool_result', tool_use_id: call.id, content: '[Not run — the user said something first. Deal with that instead.]' }
            : await runTool(call),
        )
      }
      if (awaitingWords) await settle()
      if (pending) {
        results.push({ type: 'text', text: pending })
        pending = null
      }
      messages.push({ role: 'user', content: results })
    }
  } catch (e) {
    tts.pause()
    useStore.setState({ notice: e instanceof Error ? e.message : String(e) })
  } finally {
    running = false
    useStore.setState({ agentState: 'idle' })
  }

  if (pending) {
    messages.push({ role: 'user', content: pending })
    pending = null
    void loop()
  }
}

// ---- controller wiring (the web keeps this in controller.ts; here it's a few lines) ----

voice.onUtterance = (text) => say(text)
voice.onInterim = (text) => sayInterim(text)
voice.onSpeechStart = () => beginUtterance()
voice.getRecentSpokenText = () => tts.recentlySpoken
voice.onError = (msg) => useStore.setState({ micEnabled: false, notice: msg })
tts.onParagraphChange = (i) => {
  useStore.getState().setCurrentParagraph(i)
  positionChanged() // the session debounces the save
}
tts.onPlayingChange = (playing) => useStore.setState({ playing })

export function setMicEnabled(enabled: boolean) {
  useStore.setState({ micEnabled: enabled })
  if (enabled) void voice.start()
  else voice.stop()
}

export function play() {
  const s = useStore.getState()
  void playRange(Math.min(s.currentParagraph, s.paragraphs.length - 1), s.paragraphs.length - 1)
}

export function pause() {
  tts.pause()
}
