// The library by voice, on the web: find a document or a highlight, switch to
// another document, start one at the top, a percentage or a named chapter, and
// ask what to read next. Everything the reader has is one list: their Readwise
// library (library.ts) and the articles and books saved in this browser
// (persist.ts). The picking and the matching are shared with the phone
// (shared/library).
//
// The tools are declared with every turn (clientTools), like the phone's, so
// the server's tool list stays the same for every client.
import { useStore } from '../store'
import type { Doc } from '../types'
import { searchDocs, searchHighlights } from '../../shared/library/search.ts'
import { startParagraph } from '../../shared/library/start.ts'
import { candidateLine, recommend, type Candidate } from '../../shared/library/recommend.ts'
import type { LibraryDoc } from '../../shared/library/types.ts'
import { fetchChapters, library } from './library'
import { loadLibrary, switchTo, type LibraryEntry } from './persist'

/** One thing the reader could open: a Readwise document or a document saved in this browser. */
interface Item extends Candidate {
  /** The Doc id it opens as. */
  docId: string
  readwise?: LibraryDoc
  entry?: LibraryEntry
}

const READWISE = 'readwise:'
const paragraphCount = (doc: Doc) => doc.chapters.reduce((n, c) => n + c.paragraphs.length, 0)

/** A short stable handle for a saved document: its own id is a URL or a file name. */
function savedId(docId: string): string {
  let h = 2166136261
  for (let i = 0; i < docId.length; i++) h = Math.imul(h ^ docId.charCodeAt(i), 16777619)
  return `saved-${(h >>> 0).toString(36)}`
}

/** A saved document's own progress beats Reader's: it is where this browser stopped. */
const progressOf = (entry: LibraryEntry) => (entry.currentParagraph ?? 0) / Math.max(1, paragraphCount(entry.doc))

async function items(): Promise<{ items: Item[]; error: string | null }> {
  const lib = await library()
  const saved = loadLibrary()
  const byDocId = new Map(saved.map((e) => [e.id, e]))
  const out: Item[] = lib.docs.map((d) => {
    const entry = byDocId.get(READWISE + d.id)
    return {
      id: d.id, docId: READWISE + d.id, readwise: d, entry,
      title: d.title, author: d.author, summary: d.summary, wordCount: d.wordCount,
      progress: entry ? progressOf(entry) : d.readingProgress, location: d.location, updatedAt: d.updatedAt,
    }
  })
  const listed = new Set(out.map((i) => i.docId))
  for (const e of saved) {
    if (listed.has(e.id)) continue
    const words = e.doc.chapters.reduce((n, c) => n + c.paragraphs.reduce((m, p) => m + p.split(/\s+/).length, 0), 0)
    out.push({
      id: savedId(e.id), docId: e.id, entry: e,
      title: e.title, author: null, summary: null, wordCount: words,
      progress: progressOf(e), location: 'saved', updatedAt: new Date(e.updatedAt).toISOString(),
    })
  }
  return { items: out, error: lib.error }
}

const noLibrary = (error: string | null) => (error ? ` (Readwise is not available: ${error})` : '')

// ---- the tools ----

export async function searchLibrary(input: Record<string, unknown>): Promise<string> {
  const query = String(input.query ?? '').trim()
  if (!query) return 'No query given.'
  const { items: all, error } = await items()
  const hits = searchDocs(all, query)
  if (hits.length === 0) return `Nothing in the library matches "${query}".${noLibrary(error)}`
  return hits.map(candidateLine).join('\n') + noLibrary(error)
}

export async function searchLibraryHighlights(input: Record<string, unknown>): Promise<string> {
  const query = String(input.query ?? '').trim()
  if (!query) return 'No query given.'
  const lib = await library()
  const titles = new Map(lib.docs.map((d) => [d.id, d.title]))
  const all = [
    ...lib.highlights.map((h) => ({ text: h.text, note: h.note, title: titles.get(h.docId) ?? 'an unknown document' })),
    ...loadLibrary().flatMap((e) => (e.highlights ?? []).map((h) => ({ text: h.text, note: h.note ?? null, title: e.title }))),
  ]
  const hits = searchHighlights(all, query)
  if (hits.length === 0) return `No highlight matches "${query}".${noLibrary(lib.error)}`
  return hits
    .map((h) => `"${h.text.length > 240 ? `${h.text.slice(0, 240)}...` : h.text}" (${h.title})${h.note ? ` note: ${h.note}` : ''}`)
    .join('\n')
}

export async function openDocument(input: Record<string, unknown>): Promise<string> {
  const id = String(input.id ?? '').trim()
  if (!id) return 'No document id given.'
  const { items: all } = await items()
  const item = all.find((i) => i.id === id)
  if (!item) return 'No document with that id. Search the library first.'

  const open = useStore.getState().doc
  let doc: Doc
  try {
    if (open?.id === item.docId) doc = open
    else if (item.readwise) {
      const { doc: d, chapters } = await fetchChapters(item.readwise.id)
      doc = { id: item.docId, title: d.title, source: d.sourceUrl ?? 'Readwise Reader', chapters }
    } else doc = item.entry!.doc
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }

  const from = input.from === 'beginning' ? 'beginning' : 'resume'
  const percent = typeof input.percent === 'number' ? input.percent : undefined
  const chapter = typeof input.chapter === 'string' ? input.chapter : undefined
  // Never read here, but read on the phone or in Reader: pick up from there.
  const elsewhere = !item.entry && from === 'resume' && percent == null && !chapter && (item.readwise?.readingProgress ?? 0) > 0
  const saved = open?.id === doc.id ? useStore.getState().currentParagraph : (item.entry?.currentParagraph ?? null)
  const at = startParagraph(doc.chapters, { from, percent: elsewhere ? item.readwise!.readingProgress! * 100 : percent, chapter }, saved)
  if ('error' in at) return at.error

  const where = `Position: paragraph ${at.paragraph}${at.chapter ? ` (chapter "${at.chapter}")` : ''}. Call read_aloud with no \`from\` to start reading there.`
  if (open?.id === doc.id) {
    useStore.getState().setCurrentParagraph(at.paragraph)
    return `"${doc.title}" is already open. ${where}`
  }
  switchTo(doc, item.entry, at.paragraph)
  const author = item.readwise?.author ? ` by ${item.readwise.author}` : ''
  return `Opened "${doc.title}"${author}. ${paragraphCount(doc)} paragraphs in ${doc.chapters.length} chapters. ${where}`
}

export async function recommendNext(input: Record<string, unknown>): Promise<string> {
  const minutes = typeof input.minutes === 'number' && input.minutes > 0 ? input.minutes : undefined
  const { items: all, error } = await items()
  const open = useStore.getState().doc?.id
  const picks = recommend(all.filter((i) => i.docId !== open), { minutes })
  if (picks.length === 0) return `Nothing unread to suggest.${noLibrary(error)}`
  return picks.map(candidateLine).join('\n') + noLibrary(error)
}

// ---- what the model is told ----

export const LIBRARY_TOOLS = [
  {
    name: 'search_library',
    description:
      'Find documents in the reader\'s library (their Readwise library and anything saved in this browser) by ' +
      'title, author or topic: "the Hemingway one", "that piece about sleep". Pass the words the reader used. ' +
      'Returns `[id] Title by Author (length, progress, shelf): summary`, best first. Never read ids aloud.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Title, author or topic words.' } },
      required: ['query'],
    },
  },
  {
    name: 'search_highlights',
    description:
      'Search the reader\'s highlights across every document by words in the passage or their note: "what did I ' +
      'highlight about naps", "find that line about the sea". Returns each passage with the document it is from.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words from the passage or the note.' } },
      required: ['query'],
    },
  },
  {
    name: 'open_document',
    description:
      'Switch to another document by id from search_library or recommend. Picks up where the reader left off, ' +
      'unless they asked for the beginning, a percentage ("halfway", "the last quarter") or a chapter ("chapter ' +
      'three", "the part about the storm"). Also moves within the open document when given its id. It puts the ' +
      'reader at the starting paragraph, so call read_aloud right after it with no `from`.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id from search_library or recommend.' },
        from: { type: 'string', enum: ['resume', 'beginning'], description: 'Where the reader left off (default), or the top.' },
        percent: { type: 'number', description: '0 to 100: how far in to start. "Halfway" is 50.' },
        chapter: { type: 'string', description: 'A chapter by number or by words from its title, as the reader said it.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'recommend',
    description:
      'Suggest what to read next: unfinished documents first, then the reader\'s saved-for-later shelf, then the ' +
      'inbox. Pass `minutes` when the reader says how long they have. Returns candidates in order with length, ' +
      'progress and a summary.',
    inputSchema: {
      type: 'object',
      properties: { minutes: { type: 'number', description: 'How long the reader has, if they said.' } },
    },
  },
]

export const LIBRARY_SYSTEM = `The library:
- The reader can switch documents by voice: "switch to the Hemingway one", "start that article about sleep", "go to chapter three of the storm book". Find it with search_library, then open_document, then read_aloud with no \`from\`: open_document has already put the reader where reading should start.
- If one document clearly matches, open it. If several do, say the top two or three titles in one breath and ask which.
- "From the beginning", "halfway", "the last chapter" are open_document's from, percent and chapter. With none of them, reading picks up where the reader left off.
- "What should I read next?" is recommend: offer one pick in a sentence, with why (unfinished, short enough, on their later shelf), and open it if they agree.
- "What did I highlight about X?" is search_highlights. Read the passage, not a summary of it.
- Never read ids aloud. Titles and authors only. If the library is not available, say so in a few words and offer what is saved in this browser.`

export const LIBRARY_HANDLERS = {
  search_library: searchLibrary,
  search_highlights: searchLibraryHighlights,
  open_document: openDocument,
  recommend: recommendNext,
}
