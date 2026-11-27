// The library by voice, on the web: find a document or a highlight, switch to
// another document, start one at the top, a percentage or a named chapter, and
// ask what to read next. Everything the reader has is one list: their Readwise
// library (library.ts) and the articles and books saved in this browser
// (persist.ts). The picking and the matching are shared with the phone
// (shared/library).
//
// What the model is told about these tools lives in shared/agent/clients.ts;
// the server adds it to the prompt for the web client by name.
import { useStore } from '../store'
import type { Doc } from '../types'
import { highlightLine, searchDocs, searchHighlights } from '../../shared/library/search.ts'
import { parseStartAt, startFor } from '../../shared/library/start.ts'
import { candidateLine, recommend, type Candidate } from '../../shared/library/recommend.ts'
import type { LibraryDoc } from '../../shared/library/types.ts'
import { fetchChapters, library } from './library'
import { READWISE } from './readwiseHighlights'
import { loadLibrary, switchTo, type LibraryEntry } from './persist'

/** One thing the reader could open: a Readwise document or a document saved in this browser. */
interface Item extends Candidate {
  /** The Doc id it opens as. */
  docId: string
  readwise?: LibraryDoc
  entry?: LibraryEntry
}

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
  return hits.map(highlightLine).join('\n')
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
    // A copy saved here wins over a fresh fetch: no Reader call, and the saved
    // paragraph still points at the same passage.
    if (open?.id === item.docId) doc = open
    else if (item.entry) doc = item.entry.doc
    else {
      const { doc: d, chapters } = await fetchChapters(item.readwise!.id)
      doc = { id: item.docId, title: d.title, source: d.sourceUrl ?? 'Readwise Reader', chapters }
    }
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }

  // never read here (no saved copy) means Reader's progress decides where to resume
  const saved = open?.id === doc.id ? useStore.getState().currentParagraph : item.entry ? (item.entry.currentParagraph ?? 0) : null
  const at = startFor(doc.chapters, parseStartAt(input), saved, item.readwise?.readingProgress)
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

export const LIBRARY_HANDLERS = {
  search_library: searchLibrary,
  search_highlights: searchLibraryHighlights,
  open_document: openDocument,
  recommend: recommendNext,
}
