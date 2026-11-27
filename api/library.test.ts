// /api/library: the token rides with the request, every input is checked
// before it reaches an adapter, and errors come back with the right status.
// The library port is mocked with override(); the real Readwise adapter has its
// own tests in shared/library.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { LibraryError, libraryRequest } from './_lib/library.ts'
import { override } from './_lib/providers.ts'
import { fakeLibrary } from './_lib/adapters/fake.ts'
import type { Library } from '../shared/library/types.ts'

afterEach(() => override('library', null))

describe('libraryRequest', () => {
  test('passes the caller token to the adapter and returns its answer', async () => {
    const open = vi.fn((_token: string | null) => fakeLibrary())
    override('library', open)
    const page = await libraryRequest({ op: 'list', location: 'later' }, '  tok  ')
    expect(open).toHaveBeenCalledWith('tok')
    expect('items' in page && page.items.map((d) => ('title' in d ? d.title : ''))).toEqual(['The Long Storm'])
  })

  test('the readwise provider refuses a call with no token, as a 401', async () => {
    vi.stubEnv('LIBRARY_PROVIDER', 'readwise')
    await expect(libraryRequest({ op: 'highlights' }, null)).rejects.toMatchObject({ status: 401 })
    await expect(libraryRequest({ op: 'highlights' }, '   ')).rejects.toBeInstanceOf(LibraryError)
  })

  test('a token the library rejects is a 401, anything else is left as is', async () => {
    const lib = fakeLibrary()
    lib.listHighlights = async () => { throw new Error('Readwise rejected the token — check it') }
    override('library', () => lib)
    await expect(libraryRequest({ op: 'highlights' }, 't')).rejects.toMatchObject({ status: 401 })
    lib.listHighlights = async () => { throw new Error('Readwise GET failed (500)') }
    await expect(libraryRequest({ op: 'highlights' }, 't')).rejects.not.toBeInstanceOf(LibraryError)
  })

  test('bad input never reaches the adapter', async () => {
    const lib: Library = { ...fakeLibrary(), fetchHtml: vi.fn(), listDocuments: vi.fn(), listHighlights: vi.fn(), createHighlight: vi.fn(), deleteHighlight: vi.fn() }
    override('library', () => lib)
    const bad = [
      { op: 'html', id: '../../update/x' },
      { op: 'html', id: 42 },
      { op: 'list', location: 'shortlist' },
      { op: 'list', location: 'new', cursor: 'a b' },
      { op: 'highlights', updatedAfter: 'yesterday' },
      { op: 'move', id: 'x', location: 'archive' }, // only highlight writes are served
      { op: 'createHighlight', doc: { title: 'T' }, text: '' },
      { op: 'createHighlight', doc: {}, text: 'x' },
      { op: 'createHighlight', doc: { title: 'T', sourceUrl: 'javascript:alert(1)' }, text: 'x' },
      { op: 'createHighlight', doc: { title: 'T', category: 'Books!' }, text: 'x' },
      { op: 'createHighlight', doc: { title: 'T' }, text: 'x'.repeat(8192) },
      { op: 'createHighlight', doc: { title: 'T' }, text: 'x', location: -1 },
      { op: 'createHighlight', doc: { title: 'T' }, text: 'x', location: 1.5 },
      { op: 'createHighlight', doc: { title: 'T' }, text: 'x', note: 7 },
      { op: 'deleteHighlight', remoteId: '../1' },
      { op: 'deleteHighlight' },
      null,
    ]
    for (const body of bad) await expect(libraryRequest(body, 't')).rejects.toMatchObject({ status: 400 })
    expect(lib.fetchHtml).not.toHaveBeenCalled()
    expect(lib.listDocuments).not.toHaveBeenCalled()
    expect(lib.listHighlights).not.toHaveBeenCalled()
    expect(lib.createHighlight).not.toHaveBeenCalled()
    expect(lib.deleteHighlight).not.toHaveBeenCalled()
  })

  test('a highlight goes to the adapter filed under the document, with only the fields Readwise reads', async () => {
    const lib: Library = { ...fakeLibrary(), createHighlight: vi.fn(async () => ({ remoteId: '9' })), deleteHighlight: vi.fn(async () => {}) }
    override('library', () => lib)
    const doc = { title: 'The Long Storm', author: null, sourceUrl: 'https://example.com/storm', category: 'article', summary: 'not sent' }
    expect(await libraryRequest({ op: 'createHighlight', doc, text: 'a passage', note: '.c1 why', location: 30000 }, 't')).toEqual({ remoteId: '9' })
    expect(lib.createHighlight).toHaveBeenCalledWith({
      doc: { title: 'The Long Storm', author: null, sourceUrl: 'https://example.com/storm', category: 'article' },
      text: 'a passage', note: '.c1 why', location: 30000,
    })
    await libraryRequest({ op: 'createHighlight', doc: { title: 'T' }, text: 'x', note: '' }, 't')
    expect(lib.createHighlight).toHaveBeenLastCalledWith({ doc: { title: 'T', author: null, sourceUrl: null, category: null }, text: 'x', note: undefined, location: undefined })
    expect(await libraryRequest({ op: 'deleteHighlight', remoteId: '9' }, 't')).toEqual({ ok: true })
    expect(lib.deleteHighlight).toHaveBeenCalledWith('9')
  })

  test('html for a document with text, and null for one without', async () => {
    override('library', fakeLibrary)
    const storm = await libraryRequest({ op: 'html', id: 'fake-storm' }, null)
    expect('html' in storm && storm.html).toContain('Chapter 2: The Storm')
    const pdf = await libraryRequest({ op: 'html', id: 'fake-pdf' }, null)
    expect('html' in pdf && pdf.html).toBeNull()
  })
})
