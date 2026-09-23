// The phone's half of the agent. The conversation loop itself lives in
// shared/voice/agent.ts (T18) — turn loop, fast paths, decide-then-loop, the
// pending/interruptionHandled dance, the hold that barge-in converts into a real
// interruption. This file is the adapter: it says what a player, a store, a
// transport and a tool are on this platform, and re-exports the same functions
// the screens have always imported.
//
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
import { apiJson, apiBase, shouldSayHello } from './settings'
import {
  addHighlight,
  closeDocument,
  library,
  moveDocument,
  openDocument,
  positionChanged,
  recordCheck,
  removeHighlight,
} from './session'
import { decide, type NavAction } from './navigate'
import { parseFactCheck } from './factcheck'
import type { Check, Highlight, LibraryDoc, Location } from './types'
import { createAgent, type AgentPlayer, type Block, type NavResult } from '../../shared/voice/agent'

// The conversation outlives any one document now, so it needs a ceiling.
const TRIM_ABOVE = 40
const TRIM_TO = 30

let greeted = false // the library hello happens once per app session

let counter = 0
const newId = () => `m-${Date.now()}-${++counter}`

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

// ---- tools declared on the server (read_aloud and set_speed live in the loop) ----

/**
 * Which book the turn in flight belongs to, captured the moment the reader
 * speaks. A fact check is a round-trip long enough for "is that true?" and "back
 * to the library" to overlap, and the check must not follow them into the next
 * book — nor be spoken over it.
 */
let turnDocId: string | null = null
const beginTurn = () => { turnDocId = useStore.getState().doc?.id ?? null }

/** How much of the paragraph is kept to find it again after the text has moved. */
const ANCHOR_CHARS = 120

/**
 * /api/factcheck speaks NDJSON. React Native's fetch has no streaming body, so the
 * per-field early speak the web does is off the table — await the whole thing and
 * speak the verdict once. Still one round-trip.
 *
 * The verdict is also kept: it lands in the Checks tab of the document it was
 * asked about, and is saved with that document's state.
 */
async function factCheck(input: Record<string, unknown>): Promise<string> {
  const claim = String(input.claim ?? '')
  // Read once, at the start: `turnDocId` belongs to whichever turn is running,
  // and a later one would otherwise move it under this check while it waits.
  const ownerDocId = turnDocId
  // where the reader was when they asked, taken now rather than on the way back
  const asked = useStore.getState()
  const at = Math.min(asked.currentParagraph, Math.max(0, asked.paragraphs.length - 1))
  const anchorText = asked.paragraphs[at]?.text.slice(0, ANCHOR_CHARS) ?? ''
  const anchor = asked.paragraphs.length > 0 ? at : null

  const res = await fetch(`${apiBase}/api/factcheck`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passage: claim }),
  })
  if (!res.ok) return `The fact check failed (${res.status}).`
  const parsed = parseFactCheck(await res.text())
  if ('error' in parsed) return parsed.error
  const r = parsed.result

  useStore.getState().pushChat({ id: newId(), role: 'assistant', text: `${r.verdict}: ${r.summary}` })
  // The reader put the book away while this was in flight: the line is still
  // worth having, but speaking a verdict over the library — and filing it under
  // whatever is open now — is not.
  if (!ownerDocId || useStore.getState().doc?.id !== ownerDocId) {
    return `[Already read aloud to the user, verbatim: "${r.spokenSummary}". Add nothing unless the user asked something this does not answer.]`
  }
  const check: Check = {
    id: newId(),
    claim,
    verdict: r.verdict,
    summary: r.summary,
    sources: r.sources ?? [],
    anchorText,
    anchor,
    createdAt: Date.now(),
  }
  recordCheck(ownerDocId, check)
  useStore.setState({ agentState: 'speaking' })
  await tts.speak(r.spokenSummary)
  return `[Already read aloud to the user, verbatim: "${r.spokenSummary}". Add nothing unless the user asked something this does not answer.]`
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
  // Check the id before it can reach a Readwise URL: the model supplies it.
  if (!library().byId(id)) return 'That document is not in the library.'
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

// ---- the platform-only navigation kinds ----

const SHELF_SAID: Record<Location, string> = { new: 'Back in the inbox.', later: 'Saved for later.', archive: 'Archived.', feed: 'Moved to the feed.' }

/**
 * open/list/close/file: the library kinds the web has no equivalent for. The
 * shared loop handles chapter/next/previous/beginning/pause/resume itself and
 * only ever hands these four down.
 */
async function runNav(action: NavAction): Promise<NavResult> {
  const s = useStore.getState()
  switch (action.kind) {
    case 'open': {
      try {
        const { doc, libraryDoc, position } = await openDocument(action.id)
        const line = `Opening ${doc.title}${libraryDoc.author ? ` by ${libraryDoc.author}` : ''}.`
        await agent.announceAndRead(line, position)
        return { chat: line, note: `Opened "${doc.title}" and started reading from paragraph ${position}.`, spoken: true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { chat: msg, note: `Could not open that: ${msg}` }
      }
    }
    case 'list': {
      const location = s.libraryLocation
      const docs = library().inLocation(location).sort(byRecent).slice(0, 5)
      const shelf = LOCATION_NAMES[location]
      if (docs.length === 0) return { chat: `Nothing on the ${shelf} shelf.`, note: `Told the reader the ${shelf} shelf is empty.` }
      const names = docs.map((d) => (d.author ? `${d.title} by ${d.author}` : d.title))
      const chat = `Newest in the ${shelf}: ${names.join('; ')}.`
      return { chat, note: `Listed the newest on the ${shelf} shelf: ${names.join('; ')}.` }
    }
    case 'close': {
      await closeDocument()
      return { chat: 'Back to the library.', note: 'Closed the document; the library is showing.' }
    }
    case 'file': {
      const id = s.libraryDoc?.id
      if (!id) return { chat: 'Nothing is open to file.', note: 'No document is open.' }
      try {
        const doc = await moveDocument(id, action.shelf)
        return { chat: SHELF_SAID[action.shelf], note: `Moved "${doc.title}" to ${LOCATION_NAMES[action.shelf]}.` }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { chat: msg, note: `Could not file it: ${msg}` }
      }
    }
    default:
      // the shared loop never routes its own kinds here
      return { chat: '', note: `Nothing to do for ${action.kind}.`, spoken: true }
  }
}

// ---- the loop ----

const agent = createAgent<NavAction>({
  player: {
    setParagraphs: (paragraphs) => tts.setParagraphs(paragraphs),
    setRate: (rate) => tts.setRate(rate),
    playFrom: (from, to) => tts.playFrom(from, to),
    pause: () => tts.pause(),
    hold: () => tts.hold(),
    release: () => tts.release(),
    get held() { return tts.held },
    speak: (text) => tts.speak(text),
    get currentIndex() { return tts.currentIndex },
    get recentlySpoken() { return tts.recentlySpoken },
  } satisfies AgentPlayer,
  state: {
    agentState: () => useStore.getState().agentState,
    setAgentState: (agentState) => useStore.getState().setAgentState(agentState),
    playing: () => useStore.getState().playing,
    paragraphs: () => useStore.getState().paragraphs,
    currentParagraph: () => useStore.getState().currentParagraph,
    rate: () => useStore.getState().rate,
    setRate: (rate) => useStore.getState().setRate(rate),
    chapters: () => useStore.getState().doc?.chapters ?? [],
    setInterim: (interim) => useStore.getState().setInterim(interim),
    pushChat: (m) => useStore.getState().pushChat(m),
    updateChat: (id, patch) => useStore.getState().updateChat(id, patch),
    setNotice: (notice) => useStore.setState({ notice }),
  },
  decide: (text, early) => decide(text, early),
  api: async (messages, context, extras) => {
    const { content } = await apiJson<{ content: Block[] }>('/api/agent', { messages, context, ...extras })
    return { content }
  },
  runNav,
  tools: {
    fact_check: factCheck,
    find_in_document: findInDocument,
    highlight,
    list_library: listLibrary,
    search_library: searchLibrary,
    open_document: openDoc,
    close_document: closeDoc,
    move_document: moveDoc,
    list_highlights: listHighlights,
    remove_highlight: removeHl,
  },
  buildContext,
  clientTools: CLIENT_TOOLS,
  clientSystem: CLIENT_SYSTEM,
  newId,
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  trimAbove: TRIM_ABOVE,
  trimTo: TRIM_TO,
})

// Every utterance — spoken or typed — enters the loop here, so this is where a
// turn learns which book it belongs to (see turnDocId).
export const say = (text: string): string | null => {
  beginTurn()
  return agent.say(text)
}
export const sayInterim = (text: string) => agent.sayInterim(text)
export const beginUtterance = () => agent.beginUtterance()
export const falseStart = () => agent.falseStart()

/** Forget the conversation. The UI calls this on sign-out. */
export function resetConversation() {
  agent.resetConversation()
  greeted = false
  turnDocId = null
}

/**
 * The agent's first move on a screen. 'library' is the hello, once per app
 * session; 'document' is a document the reader opened by tapping (a voice-opened
 * one carries its own tool result), so the agent picks up reading unprompted.
 */
export function openingTurn(kind: 'library' | 'document') {
  beginTurn()
  if (kind === 'library') {
    if (greeted) return
    // greeted only once the cue is actually taken: a hello refused because a turn
    // was already in flight should still be said later.
    if (
      agent.openingTurn(
        () => '[The reader is looking at their library and listening. Say hello in one short line and ask what they\'d like to read, or offer the newest item in the inbox by title.]',
      )
    )
      greeted = true
    return
  }
  // a tap mid-turn queues: the loop picks it up as the next thing the reader "said"
  agent.openingTurn(
    () => {
      const s = useStore.getState()
      if (!s.doc) return null
      const total = s.paragraphs.length
      const position = Math.min(s.currentParagraph, Math.max(0, total - 1))
      const chapter = chapterTitleAt(position)
      return `[The reader opened "${s.doc.title}" by hand. Position is paragraph ${position} of ${total}${chapter ? `, in chapter "${chapter}"` : ''}. Pick up reading from there.]`
    },
    { queueWhileRunning: true },
  )
}

// ---- controller wiring (the web keeps this in controller.ts; here it's a few lines) ----

voice.onUtterance = (text) => say(text)
voice.onInterim = (text) => sayInterim(text)
voice.onSpeechStart = () => beginUtterance()
// the level gate held the narration and no words came: resume it (3.2A / X2)
voice.onFalseStart = () => falseStart()
voice.getRecentSpokenText = () => tts.recentlySpoken
voice.onError = (msg) => useStore.setState({ micEnabled: false, notice: msg })
tts.onParagraphChange = (i) => {
  useStore.getState().setCurrentParagraph(i)
  positionChanged() // the session debounces the save
}
tts.onPlayingChange = (playing) => {
  useStore.setState({ playing })
  voice.setPlaying(playing) // the level gate only fires during narration
}

export function setMicEnabled(enabled: boolean) {
  useStore.setState({ micEnabled: enabled })
  if (enabled) {
    void voice.start()
    // the ear coming on in the library is the moment to say hello: once a day (3.1A)
    if (!useStore.getState().doc && shouldSayHello()) openingTurn('library')
  } else voice.stop()
}

export function play() {
  const s = useStore.getState()
  void agent.playRange(Math.min(s.currentParagraph, s.paragraphs.length - 1), s.paragraphs.length - 1)
}

export function pause() {
  tts.pause()
}
