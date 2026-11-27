// The pure parts of the hands-free library: finding a document or a highlight
// by voice, picking where to start reading, and choosing what to suggest next.
import { describe, expect, test } from 'vitest'
import { searchDocs, searchHighlights } from './search.ts'
import { findChapter, startParagraph } from './start.ts'
import { candidateLine, recommend, type Candidate } from './recommend.ts'
import type { Chapter } from './types.ts'

const docs = [
  { id: 'a', title: 'The Old Man and the Sea', author: 'Ernest Hemingway', summary: 'A fisherman and a marlin.', updatedAt: '2026-01-01' },
  { id: 'b', title: 'Why We Sleep', author: 'Matthew Walker', summary: 'The science of sleep and dreams.', updatedAt: '2026-01-02' },
  { id: 'c', title: 'Sea Change', author: 'Someone Else', summary: null, updatedAt: '2026-01-03' },
]

describe('searchDocs', () => {
  test('loose spoken queries find the right document', () => {
    expect(searchDocs(docs, 'the hemingway one')[0].id).toBe('a')
    expect(searchDocs(docs, 'that article about sleep')[0].id).toBe('b')
  })
  test('matching every word beats matching one', () => {
    expect(searchDocs(docs, 'hemingway sea').map((d) => d.id)).toEqual(['a', 'c'])
  })
  test('nothing to search for, nothing found', () => {
    expect(searchDocs(docs, 'the one')).toEqual([])
    expect(searchDocs(docs, 'quantum')).toEqual([])
  })
})

describe('searchHighlights', () => {
  const hs = [
    { text: 'The sea is a cruel mistress.', note: null },
    { text: 'Sleep is the single most effective thing we can do.', note: 'use in talk' },
    { text: 'A cruel joke, then the punchline.', note: null },
  ]
  test('finds by words in the passage or the note', () => {
    expect(searchHighlights(hs, 'sleep')[0]).toBe(hs[1])
    expect(searchHighlights(hs, 'my talk')[0]).toBe(hs[1])
  })
  test('the exact phrase ranks first', () => {
    expect(searchHighlights(hs, 'cruel mistress')[0]).toBe(hs[0])
  })
})

const chapters: Chapter[] = [
  { title: 'Preface', paragraphs: ['p0', 'p1'] },
  { title: 'Chapter 1: The Storm', paragraphs: ['p2', 'p3', 'p4'] },
  { title: 'Chapter 2: Landfall', paragraphs: ['p5', 'p6'] },
  { title: 'III', paragraphs: ['p7', 'p8', 'p9'] },
]

describe('findChapter', () => {
  test('by a number in the title, spoken or written', () => {
    expect(findChapter(chapters, 'chapter one')).toBe(1)
    expect(findChapter(chapters, 'chapter 2')).toBe(2)
    expect(findChapter(chapters, 'chapter three')).toBe(3) // matches the roman numeral
  })
  test('by words from the title', () => {
    expect(findChapter(chapters, 'the one about the storm')).toBe(1)
    expect(findChapter(chapters, 'landfall')).toBe(2)
    // "one" here is not a number: the storm is chapter 2, not chapter 1
    const numbered: Chapter[] = [{ title: 'Chapter 1: Harbor', paragraphs: ['a'] }, { title: 'Chapter 2: The Storm', paragraphs: ['b'] }]
    expect(findChapter(numbered, 'the one about the storm')).toBe(1)
  })
  test('the last chapter, and ordinals', () => {
    expect(findChapter(chapters, 'the last chapter')).toBe(chapters.length - 1)
    const plain: Chapter[] = [{ title: 'Opening', paragraphs: ['a'] }, { title: 'Middle', paragraphs: ['b'] }]
    expect(findChapter(plain, 'the second chapter')).toBe(1)
    expect(findChapter(plain, 'two')).toBe(1)
  })
  test('a number with no titled match counts chapters', () => {
    const plain: Chapter[] = [{ title: 'Opening', paragraphs: ['a'] }, { title: 'Middle', paragraphs: ['b'] }]
    expect(findChapter(plain, 'chapter 2')).toBe(1)
    expect(findChapter(plain, 'chapter 9')).toBeNull()
    // "I" in a title is a word, not a numeral
    const prose: Chapter[] = [{ title: 'Prologue', paragraphs: ['a'] }, { title: 'What I Saw', paragraphs: ['b'] }, { title: 'Chapter 1', paragraphs: ['c'] }]
    expect(findChapter(prose, 'chapter one')).toBe(2)
  })
})

describe('startParagraph', () => {
  test('resumes at the saved position by default, or the top with none', () => {
    expect(startParagraph(chapters, {}, 6)).toEqual({ paragraph: 6, chapter: 'Chapter 2: Landfall' })
    expect(startParagraph(chapters, {}, null)).toEqual({ paragraph: 0, chapter: 'Preface' })
  })
  test('from the beginning ignores the saved position', () => {
    expect(startParagraph(chapters, { from: 'beginning' }, 6)).toEqual({ paragraph: 0, chapter: 'Preface' })
  })
  test('a percentage, clamped to the document', () => {
    expect(startParagraph(chapters, { percent: 50 }, 6)).toEqual({ paragraph: 5, chapter: 'Chapter 2: Landfall' })
    expect(startParagraph(chapters, { percent: 100 }, null)).toEqual({ paragraph: 9, chapter: 'III' })
    expect(startParagraph(chapters, { percent: -5 }, 6)).toEqual({ paragraph: 0, chapter: 'Preface' })
  })
  test('a chapter wins over a percentage', () => {
    expect(startParagraph(chapters, { chapter: 'the storm', percent: 90 }, null)).toEqual({ paragraph: 2, chapter: 'Chapter 1: The Storm' })
  })
  test('an unknown chapter says which chapters there are', () => {
    const r = startParagraph(chapters, { chapter: 'epilogue' }, null)
    expect('error' in r && r.error).toMatch(/No chapter matches "epilogue".*Preface; Chapter 1: The Storm/)
  })
  test('a saved position past the end is clamped', () => {
    expect(startParagraph(chapters, {}, 99)).toEqual({ paragraph: 9, chapter: 'III' })
  })
  test('one chapter has no chapter name to report', () => {
    expect(startParagraph([{ title: 'Doc', paragraphs: ['a', 'b'] }], { percent: 50 }, null)).toEqual({ paragraph: 1, chapter: null })
  })
})

describe('recommend', () => {
  const lib: Candidate[] = [
    { id: 'inbox', title: 'Inbox piece', location: 'new', wordCount: 1500, updatedAt: '2026-01-05' },
    { id: 'later', title: 'Saved piece', location: 'later', wordCount: 3000, updatedAt: '2026-01-01' },
    { id: 'half', title: 'Half read', location: 'later', wordCount: 60000, progress: 0.5, updatedAt: '2025-12-01' },
    { id: 'done', title: 'Finished', location: 'later', wordCount: 1000, progress: 0.99 },
    { id: 'arch', title: 'Archived', location: 'archive', wordCount: 1000 },
  ]
  test('unfinished first, then later, then the inbox; archived and finished left out', () => {
    expect(recommend(lib).map((c) => c.id)).toEqual(['half', 'later', 'inbox'])
  })
  test('with a time limit, what fits comes first', () => {
    // 15 minutes is about 2250 words: only the inbox piece fits
    expect(recommend(lib, { minutes: 15 }).map((c) => c.id)).toEqual(['inbox', 'half', 'later'])
  })
  test('a line says how long, how far and where', () => {
    expect(candidateLine(lib[2])).toBe('[half] Half read (200 min left, 50% read, later)')
    expect(candidateLine({ id: 'x', title: 'T', author: 'A', location: 'new', wordCount: 300, summary: 'S.' })).toBe('[x] T by A (2 min, inbox): S.')
  })
})
