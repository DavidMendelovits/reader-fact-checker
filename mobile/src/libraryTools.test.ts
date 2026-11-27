// The phone's recommend and search_highlights (libraryTools.ts): the open book
// is never suggested; the open book's own highlights are found before Reader
// has them, as one thought; and one removed here is not found again.
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { findHighlights, recommendNext } from './libraryTools.ts'
import type { Highlight, LibraryDoc, RemoteHighlight } from './types.ts'

const doc = (id: string, more: Partial<LibraryDoc> = {}): LibraryDoc => ({
  id, title: `Title ${id}`, author: null, category: 'article', location: 'later', sourceUrl: null,
  wordCount: 1500, summary: null, tags: [], readingProgress: null, publishedDate: null, updatedAt: '2026-01-01', ...more,
})
const remote = (id: string, docId: string, text: string): RemoteHighlight => ({ id, docId, text, note: null, updatedAt: '2026-01-01' })
const own = (id: string, text: string, more: Partial<Highlight> = {}): Highlight => ({ id, text, anchor: null, createdAt: 0, ...more })

test('recommend: unfinished first, the open book left out, minutes passed through', () => {
  const docs = [doc('a'), doc('b', { readingProgress: 0.4 }), doc('open', { readingProgress: 0.5 })]
  const lines = recommendNext({ docs, progress: {} }, 'open', {}).split('\n')
  assert.match(lines[0], /^\[b\] Title b/)
  assert.ok(!lines.some((l) => l.startsWith('[open]')))
  // 3 minutes fits neither 1500-word piece, so both stay, in the usual order
  assert.match(recommendNext({ docs, progress: {} }, 'open', { minutes: 3 }), /^\[b\]/)
  assert.equal(recommendNext({ docs: [doc('done', { readingProgress: 0.99 })], progress: {} }, null, {}), 'Nothing unread to suggest.')
})

test("recommend: the phone's own progress beats Reader's", () => {
  const docs = [doc('a'), doc('b', { readingProgress: 0.4 })]
  // half read on the phone (Reader never heard), and b finished on the phone
  const lines = recommendNext({ docs, progress: { a: 0.5, b: 0.99 } }, null, {}).split('\n')
  assert.deepEqual(lines.map((l) => l.slice(0, 3)), ['[a]'])
  assert.match(lines[0], /50% read/)
})

test('search_highlights: Reader\'s, under their document\'s title', () => {
  const out = findHighlights({ query: 'naps' }, { docs: [doc('s', { title: 'Why We Sleep' })], remoteHighlights: [remote('r1', 's', 'Naps help memory.')] }, null)
  assert.equal(out, '"Naps help memory." (Why We Sleep)')
  assert.equal(findHighlights({ query: ' ' }, { docs: [], remoteHighlights: [] }, null), 'No query given.')
})

test('search_highlights: the open book\'s new highlights are found as one thought, once', () => {
  const lib = { docs: [doc('s')], remoteHighlights: [remote('r1', 's', 'The sea was calm.')] }
  const open = {
    title: 'Open Book',
    highlights: [
      own('h1', 'The sea was calm.', { remoteId: 'r1' }), // already in Reader: found there, not twice
      own('h2', 'A setup about the sea', { group: 'g', note: 'ha' }),
      own('h3', 'and its punchline', { group: 'g' }),
    ],
  }
  const lines = findHighlights({ query: 'sea' }, lib, open).split('\n')
  assert.equal(lines.length, 2)
  assert.ok(lines.includes('"The sea was calm." (Title s)'))
  assert.ok(lines.some((l) => l.startsWith('"A setup about the sea') && l.includes('punchline') && l.endsWith('(Open Book) note: ha')))
})

test('search_highlights: a thought only partly in Reader is found once, as one', () => {
  const lib = { docs: [doc('s')], remoteHighlights: [remote('r2', 's', 'A setup about the sea')] }
  const open = {
    title: 'Open Book',
    highlights: [own('h2', 'A setup about the sea', { group: 'g', remoteId: 'r2' }), own('h3', 'and its punchline', { group: 'g', pending: 'create' })],
  }
  const lines = findHighlights({ query: 'sea' }, lib, open).split('\n')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /punchline.*\(Open Book\)$/)
})

test('search_highlights: one removed here is not found, even before Readwise hears', () => {
  const lib = { docs: [doc('s')], remoteHighlights: [remote('r1', 's', 'The sea was calm.')] }
  const open = { title: 'Open Book', highlights: [own('h1', 'The sea was calm.', { remoteId: 'r1', pending: 'delete' })] }
  assert.equal(findHighlights({ query: 'sea' }, lib, open), 'No highlight matches "sea".')
})
