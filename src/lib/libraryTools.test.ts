// The web library tools: what the model sees from a search, and where opening a
// document puts the reader. The library sync and the saved-documents store are
// mocked; the matching and start-at logic is the real shared code.
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Chapter, LibraryDoc, RemoteHighlight } from '../../shared/library/types.ts'
import type { LibraryEntry } from './persist'
import type { Doc } from '../types'

const lib = vi.hoisted(() => ({
  docs: [] as LibraryDoc[],
  highlights: [] as RemoteHighlight[],
  error: null as string | null,
  chapters: new Map<string, Chapter[]>(),
}))
const saved = vi.hoisted(() => ({ entries: [] as LibraryEntry[], switched: [] as { doc: Doc; at: number }[] }))

vi.mock('./library', () => ({
  library: async () => ({ docs: lib.docs, highlights: lib.highlights, error: lib.error }),
  fetchChapters: async (id: string) => {
    const doc = lib.docs.find((d) => d.id === id)!
    const chapters = lib.chapters.get(id)
    if (!chapters) throw new Error(`Reader has no readable text for "${doc.title}".`)
    return { doc, chapters }
  },
}))
vi.mock('./persist', async () => {
  const { useStore } = await import('../store')
  return {
    loadLibrary: () => saved.entries,
    switchTo: (doc: Doc, _entry: unknown, at: number) => {
      saved.switched.push({ doc, at })
      useStore.getState().setDoc(doc)
      useStore.getState().setCurrentParagraph(at)
    },
  }
})

const { openDocument, recommendNext, searchLibrary, searchLibraryHighlights } = await import('./libraryTools')
const { useStore } = await import('../store')

const paras = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} paragraph ${i + 1}.`)
const STORM: Chapter[] = [
  { title: 'Harbor', paragraphs: paras(4, 'harbor') },
  { title: 'The Storm', paragraphs: paras(4, 'storm') },
  { title: 'Morning', paragraphs: paras(2, 'morning') },
]
const rw = (id: string, title: string, over: Partial<LibraryDoc> = {}): LibraryDoc => ({
  id, title, author: 'Ada Writer', summary: null, sourceUrl: null, wordCount: 3000,
  readingProgress: 0, location: 'later', updatedAt: '2026-11-01T00:00:00Z', category: 'article', ...over,
} as LibraryDoc)

beforeEach(() => {
  lib.docs = [
    rw('storm', 'The Long Storm', { readingProgress: 0.4 }),
    rw('sleep', 'Notes on Sleep', { location: 'new', wordCount: 900, author: 'Sam Rest' }),
  ]
  lib.highlights = [{ id: 'h1', docId: 'sleep', text: 'A nap is a small vacation.', note: null } as RemoteHighlight]
  lib.error = null
  lib.chapters = new Map([['storm', STORM], ['sleep', [{ title: 'Notes on Sleep', paragraphs: paras(3, 'sleep') }]]])
  saved.entries = []
  saved.switched = []
  useStore.setState({ doc: null, currentParagraph: 0 })
})

describe('search', () => {
  test('lists matches with an id the model can open, best first', async () => {
    const out = await searchLibrary({ query: 'the storm book' })
    expect(out.split('\n')[0]).toMatch(/^\[storm\] The Long Storm by Ada Writer \(\d+ min left, 40% read, later\)/)
  })

  test('says when nothing matches, and why the library may be thin', async () => {
    lib.error = 'Readwise rejected the token'
    expect(await searchLibrary({ query: 'volcanoes' })).toBe(
      'Nothing in the library matches "volcanoes". (Readwise is not available: Readwise rejected the token)',
    )
  })

  test('highlights come back with the document they are from', async () => {
    expect(await searchLibraryHighlights({ query: 'nap' })).toBe('"A nap is a small vacation." (Notes on Sleep)')
  })
})

describe('open_document', () => {
  test('picks up where Reader left off when it was never read here', async () => {
    const out = await openDocument({ id: 'storm' })
    expect(out).toMatch(/^Opened "The Long Storm" by Ada Writer\. 10 paragraphs in 3 chapters\. Position: paragraph 4 \(chapter "The Storm"\)/)
    expect(saved.switched.map((s) => [s.doc.id, s.at])).toEqual([['readwise:storm', 4]])
    expect(useStore.getState().currentParagraph).toBe(4)
  })

  test('the beginning, a percentage and a chapter by name', async () => {
    expect(await openDocument({ id: 'storm', from: 'beginning' })).toContain('Position: paragraph 0 (chapter "Harbor")')
    expect(await openDocument({ id: 'storm', percent: 90 })).toContain('is already open. Position: paragraph 9 (chapter "Morning")')
    expect(await openDocument({ id: 'storm', chapter: 'the storm' })).toContain('Position: paragraph 4')
    expect(useStore.getState().currentParagraph).toBe(4)
    expect(saved.switched).toHaveLength(1) // the later two moved within the open document
  })

  test('a chapter that is not there lists the ones that are', async () => {
    expect(await openDocument({ id: 'storm', chapter: 'twelve' })).toMatch(/Harbor.*The Storm.*Morning/)
    expect(saved.switched).toHaveLength(0)
  })

  test('a document saved in this browser resumes from its own place', async () => {
    const doc: Doc = { id: 'https://example.com/tides', title: 'Tides', source: 'example.com', chapters: [{ title: 'Tides', paragraphs: paras(6, 'tide') }] }
    saved.entries = [{ id: doc.id, title: 'Tides', source: 'example.com', doc, currentParagraph: 3, updatedAt: Date.now() } as LibraryEntry]
    const id = (await searchLibrary({ query: 'tides' })).match(/^\[([^\]]+)\]/)![1]
    expect(id).toMatch(/^saved-/)
    expect(await openDocument({ id })).toContain('Position: paragraph 3.')
    expect(saved.switched[0].doc).toBe(doc)
  })

  test('an id it does not know, and a document with no text', async () => {
    expect(await openDocument({ id: 'nope' })).toBe('No document with that id. Search the library first.')
    lib.chapters.delete('sleep')
    expect(await openDocument({ id: 'sleep' })).toContain('no readable text')
  })
})

describe('recommend', () => {
  test('unfinished first, never the open document, and a short one when time is short', async () => {
    expect((await recommendNext({})).split('\n')[0]).toMatch(/^\[storm\]/)
    await openDocument({ id: 'storm' })
    expect((await recommendNext({})).split('\n')[0]).toMatch(/^\[sleep\]/)
    useStore.setState({ doc: null })
    expect((await recommendNext({ minutes: 8 })).split('\n')[0]).toMatch(/^\[sleep\]/)
  })
})
