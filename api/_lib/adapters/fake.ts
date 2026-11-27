// Stand-ins for every server port, for the end-to-end test environment only:
// no keys, no network, no cost. `npm run dev:e2e` runs the whole app on these
// (.env.e2e), so a browser or device test can click through a real session.
// Unit and integration tests mock the port they need instead. Each fake is
// deterministic and small; they prove the wiring, not the vendor.
//
//   conversation  a rule table that answers like the agent would: greet and
//                 read, check a claim in the background, highlight, answer
//   json          no claims
//   search        a verdict after FAKE_SEARCH_MS (default 4s), streamed in pieces
//   speech        silent MP3, about as long as the text would take to say
//   library       three documents and two highlights, whatever the token
import type {
  AudioStream, Block, ConversationModel, JsonCompletion, Message, SearchModel, SpeechSynthesizer, TurnHooks, TurnRequest,
} from '../ports.js'
import type { Library, LibraryDoc, RemoteHighlight } from '../../../shared/library/types.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let ids = 0
const toolUse = (name: string, input: Record<string, unknown>): Block => ({
  type: 'tool_use', id: `fake_${++ids}`, name, input,
})

/** What the user last said, ignoring tool results: an interruption rides with them. */
function lastUserText(messages: Message[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user')
  if (!last) return ''
  if (typeof last.content === 'string') return last.content
  return last.content
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
}

/** The tool results in the last user turn, if that is all it carries. */
function lastToolResults(messages: Message[]): string[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user' || typeof last.content === 'string') return []
  return last.content
    .filter((b): b is Extract<Block, { type: 'tool_result' }> => b.type === 'tool_result')
    .map((b) => String(b.content))
}

/**
 * The library round trip, so a click-through can switch documents: "open X"
 * searches, a search result opens the first match, and an opened document is
 * read from wherever opening it put the reader.
 */
function libraryStep(results: string[]): Block[] | null {
  for (const r of results) {
    if (/^Opened |is already open/.test(r)) return [toolUse('read_aloud', {})]
    const found = r.match(/^\[([a-z][\w-]*)\]/i) // a library id, not find_in_document's [12]
    if (found) return [toolUse('open_document', { id: found[1] })]
  }
  return null
}

/** The current paragraph index and its text, read back out of the context block. */
function position(context: string): { at: number; text: string } {
  const at = Number(context.match(/Current position: paragraph (\d+)/)?.[1] ?? 0)
  const text = context.match(new RegExp(`\\[${at}\\] ([^\\n]+)`))?.[1] ?? ''
  return { at, text }
}

function reply(text: string, context: string, results: string[]): Block[] {
  const { at, text: here } = position(context)
  const t = text.toLowerCase()
  const read = () => toolUse('read_aloud', { from: at })
  if (!t.trim()) return libraryStep(results) ?? [] // tool results only
  const open = t.trim().match(/^(?:switch to|open|start reading)\s+(.+)/)
  if (open) return [toolUse('search_library', { query: open[1] })]
  if (/what should i read|recommend/.test(t)) return [toolUse('recommend', {})]
  if (t.startsWith('[the reader')) return [{ type: 'text', text: 'Starting where you are.' }, read()]
  if (/\b(true|check|really|accurate|fact)\b/.test(t)) {
    return [
      { type: 'text', text: "I'll check that in the background." },
      toolUse('fact_check', { claim: here || text, anchor: at }),
      read(),
    ]
  }
  if (/\b(highlight|save)\b/.test(t)) return [toolUse('highlight', { text: here, anchor: at }), read()]
  if (/where am i/.test(t)) return [{ type: 'text', text: `You're at paragraph ${at}.` }, read()]
  return [{ type: 'text', text: `You said: ${text.slice(0, 80)}.` }, read()]
}

export function fakeConversation(): ConversationModel {
  return {
    name: 'fake',
    async turn(req: TurnRequest, hooks: TurnHooks = {}) {
      const content = reply(lastUserText(req.messages), req.context, lastToolResults(req.messages))
      for (const b of content) {
        if (b.type !== 'text') continue
        await sleep(30)
        hooks.onText?.(b.text as string)
        hooks.onTextEnd?.()
      }
      return { content, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    },
  }
}

export function fakeJson(): JsonCompletion {
  return { name: 'fake', complete: async () => JSON.stringify({ claims: [] }) }
}

export function fakeSearch(opts: { delayMs?: number } = {}): SearchModel {
  return {
    name: 'fake',
    async answer(req, onDelta = () => {}) {
      const delay = opts.delayMs ?? Number(process.env.FAKE_SEARCH_MS ?? 4000)
      const claim = req.user.match(/"""([\s\S]*)"""/)?.[1] ?? req.user
      const words = claim.trim().split(/\s+/).slice(0, 6).join(' ')
      const text = JSON.stringify({
        verdict: 'unverifiable',
        spokenSummary: `Offline check: nothing was searched for "${words}".`,
        summary: 'This verdict came from the offline fake search provider. No web search ran.',
      })
      // three pieces, so the streaming path is exercised the way a real verdict is
      const step = Math.ceil(text.length / 3)
      for (let i = 0; i < text.length; i += step) {
        await sleep(delay / 3)
        onDelta(text.slice(i, i + step))
      }
      return { text, sources: [{ title: 'Offline fake source', url: 'https://example.com/' }] }
    },
  }
}

/**
 * One silent MPEG-1 Layer III frame: 32 kbps, 44.1 kHz, mono. 104 bytes, 1152
 * samples (about 26 ms). All-zero side info decodes as silence.
 */
const SILENT_FRAME = (() => {
  const f = new Uint8Array(104)
  f.set([0xff, 0xfb, 0x10, 0xc0])
  return f
})()
const FRAME_MS = 1152 / 44.1
const CHARS_PER_SECOND = 15 // about how fast a narrator reads

export function fakeSpeech(): SpeechSynthesizer {
  return {
    name: 'fake',
    mimeType: 'audio/mpeg',
    maxChars: null,
    async synthesize(text: string): Promise<AudioStream> {
      const frames = Math.max(4, Math.round(((text.length / CHARS_PER_SECOND) * 1000) / FRAME_MS))
      const bytes = new Uint8Array(frames * SILENT_FRAME.length)
      for (let i = 0; i < frames; i++) bytes.set(SILENT_FRAME, i * SILENT_FRAME.length)
      return { mimeType: 'audio/mpeg', body: new Blob([bytes]).stream() }
    },
  }
}

const FAKE_DOCS: { doc: LibraryDoc; html: string | null }[] = [
  {
    doc: fakeDoc('fake-storm', 'The Long Storm', 'A. Writer', 'later', 0.4, 'A sailor waits out a storm.'),
    html:
      '<h1>Chapter 1: Harbor</h1><p>The boats came in early that evening, one after another, low in the water.</p>' +
      '<p>Nobody on the quay said the word storm, but everyone was tying things down.</p>' +
      '<h1>Chapter 2: The Storm</h1><p>By midnight the wind had found every loose shutter in town.</p>' +
      '<p>She sat by the stove and counted the seconds between the gusts.</p>' +
      '<h1>Chapter 3: Morning</h1><p>The sea in the morning was flat and grey and pretended nothing had happened.</p>',
  },
  {
    doc: fakeDoc('fake-sleep', 'Notes on Sleep', 'B. Researcher', 'new', null, 'Why a short nap helps.'),
    html: '<p>A short nap in the early afternoon improves alertness for hours afterwards.</p><p>Longer naps leave most people groggy.</p>',
  },
  { doc: fakeDoc('fake-pdf', 'A Scanned Report', null, 'new', null, 'A PDF with no text.'), html: null },
]

const FAKE_HIGHLIGHTS: RemoteHighlight[] = [
  { id: 'fake-h1', docId: 'fake-storm', text: 'The sea in the morning was flat and grey and pretended nothing had happened.', note: null, updatedAt: '2026-01-02T00:00:00Z' },
  { id: 'fake-h2', docId: 'fake-sleep', text: 'A short nap in the early afternoon improves alertness for hours afterwards.', note: 'try this', updatedAt: '2026-01-01T00:00:00Z' },
]

function fakeDoc(id: string, title: string, author: string | null, location: LibraryDoc['location'], progress: number | null, summary: string): LibraryDoc {
  return {
    id, title, author, category: 'article', location, sourceUrl: null, wordCount: 1200, summary,
    tags: [], readingProgress: progress, publishedDate: null, updatedAt: '2026-01-01T00:00:00Z',
  }
}

/** The same small library for every caller: no token, no network. Writes are accepted and forgotten. */
export function fakeLibrary(): Library {
  return {
    async listDocuments({ location }) {
      return { items: FAKE_DOCS.map((d) => d.doc).filter((d) => d.location === location), nextCursor: null }
    },
    async fetchHtml(id) {
      const hit = FAKE_DOCS.find((d) => d.doc.id === id)
      if (!hit) throw new Error('Document not found in Reader')
      return hit
    },
    async move() {},
    async listHighlights() {
      return { items: FAKE_HIGHLIGHTS, nextCursor: null }
    },
    async createHighlight() {
      return { remoteId: `fake-${++ids}` }
    },
    async deleteHighlight() {},
  }
}
