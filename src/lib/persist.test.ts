// Which saved document goes when the local library is full: a Readwise copy
// (fetched again on demand) before an imported book (needs another upload).
import { describe, expect, test, vi } from 'vitest'
import type { LibraryEntry } from './persist'

vi.mock('./agent', () => ({ exportMessages: () => [], keepConversation: () => {}, markReopened: () => {}, restoreMessages: () => {} }))
vi.mock('./providers', () => ({ tts: { clearCacheForNewDoc: () => {} } }))
vi.stubGlobal('window', { addEventListener: () => {} })
const { dropOne } = await import('./persist')

const e = (id: string) => ({ id }) as LibraryEntry
const ids = (es: LibraryEntry[]) => es.map((x) => x.id)

describe('dropOne', () => {
  test('the oldest Readwise copy goes first, even if a book is older', () => {
    const list = [e('book-new'), e('readwise:a'), e('readwise:b'), e('book-old')]
    dropOne(list)
    expect(ids(list)).toEqual(['book-new', 'readwise:a', 'book-old'])
  })
  test('with no Readwise copies, the oldest entry', () => {
    const list = [e('book-new'), e('book-old')]
    dropOne(list)
    expect(ids(list)).toEqual(['book-new'])
  })
  test('never the newest, the document being saved, while anything else is left', () => {
    const list = [e('readwise:open'), e('book-a'), e('book-b')]
    dropOne(list)
    expect(ids(list)).toEqual(['readwise:open', 'book-a'])
    const alone = [e('readwise:open')]
    dropOne(alone)
    expect(alone).toEqual([])
  })
})
