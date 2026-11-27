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
    const lib: Library = { ...fakeLibrary(), fetchHtml: vi.fn(), listDocuments: vi.fn(), listHighlights: vi.fn() }
    override('library', () => lib)
    const bad = [
      { op: 'html', id: '../../update/x' },
      { op: 'html', id: 42 },
      { op: 'list', location: 'shortlist' },
      { op: 'list', location: 'new', cursor: 'a b' },
      { op: 'highlights', updatedAfter: 'yesterday' },
      { op: 'move', id: 'x', location: 'archive' }, // writes aren't served
      null,
    ]
    for (const body of bad) await expect(libraryRequest(body, 't')).rejects.toMatchObject({ status: 400 })
    expect(lib.fetchHtml).not.toHaveBeenCalled()
    expect(lib.listDocuments).not.toHaveBeenCalled()
    expect(lib.listHighlights).not.toHaveBeenCalled()
  })

  test('html for a document with text, and null for one without', async () => {
    override('library', fakeLibrary)
    const storm = await libraryRequest({ op: 'html', id: 'fake-storm' }, null)
    expect('html' in storm && storm.html).toContain('Chapter 2: The Storm')
    const pdf = await libraryRequest({ op: 'html', id: 'fake-pdf' }, null)
    expect('html' in pdf && pdf.html).toBeNull()
  })
})
