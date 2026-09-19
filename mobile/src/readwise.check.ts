// Self-check for the Readwise adapter. Run it with:
//
//   node --experimental-strip-types src/readwise.check.ts
//
// The adapter is the only place that knows Reader's URLs, query names and
// response shapes, so a wrong field here is a library that syncs nothing and
// says so quietly. A fake Reader/Readwise stands in for the real one: it
// checks the token header, records every request, pages a listing, drops a
// highlight and a note into the document list, throttles one write once, and
// answers highlight creation the way v2 actually does — with the books it
// touched, not the highlight.
import assert from 'node:assert/strict'
import http from 'node:http'
import { readwiseLibrary, toLibraryDoc } from './readwise.ts'
import type { ReaderDoc } from './types.ts'

const readerDoc = (over: Partial<ReaderDoc>): ReaderDoc => ({
  id: 'd1',
  title: 'A Title',
  author: 'An Author',
  category: 'article',
  location: 'new',
  source_url: 'https://example.com/a',
  word_count: 1200,
  summary: 'A summary.',
  tags: null,
  reading_progress: 0.25,
  published_date: '2024-05-01',
  parent_id: null,
  content: null,
  notes: null,
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
})

// ---- toLibraryDoc: Reader's fields in the app's terms ----

assert.deepEqual(toLibraryDoc(readerDoc({})), {
  id: 'd1',
  title: 'A Title',
  author: 'An Author',
  category: 'article',
  location: 'new',
  sourceUrl: 'https://example.com/a',
  wordCount: 1200,
  summary: 'A summary.',
  tags: [],
  readingProgress: 0.25,
  publishedDate: '2024-05-01',
  updatedAt: '2026-01-01T00:00:00Z',
})
// tags come as an object keyed by name (or, older, an array); the app wants names
assert.deepEqual(toLibraryDoc(readerDoc({ tags: { philosophy: { name: 'philosophy' }, long: {} } })).tags, ['philosophy', 'long'])
assert.deepEqual(toLibraryDoc(readerDoc({ tags: ['a', 'b'] })).tags, ['a', 'b'])
// a missing or blank title is "Untitled"; blank author and summary are null
assert.equal(toLibraryDoc(readerDoc({ title: null })).title, 'Untitled')
assert.equal(toLibraryDoc(readerDoc({ title: '   ' })).title, 'Untitled')
assert.equal(toLibraryDoc(readerDoc({ title: '  Padded  ' })).title, 'Padded')
assert.equal(toLibraryDoc(readerDoc({ author: '  ' })).author, null)
assert.equal(toLibraryDoc(readerDoc({ summary: '' })).summary, null)
// locations the app doesn't file under fall back to the inbox
assert.equal(toLibraryDoc(readerDoc({ location: 'shortlist' })).location, 'new')
assert.equal(toLibraryDoc(readerDoc({ location: null })).location, 'new')
assert.equal(toLibraryDoc(readerDoc({ location: 'feed' })).location, 'feed')
assert.equal(toLibraryDoc(readerDoc({ location: 'archive' })).location, 'archive')
// odd shapes from the wire
assert.equal(toLibraryDoc(readerDoc({ reading_progress: null })).readingProgress, null)
assert.equal(toLibraryDoc(readerDoc({ published_date: 1714521600000 })).publishedDate, '1714521600000')
assert.equal(toLibraryDoc(readerDoc({ published_date: null })).publishedDate, null)

// ---- the fake server ----

interface Seen {
  method: string
  path: string
  query: Record<string, string>
  auth: string | undefined
  contentType: string | undefined
  body: unknown
}
const seen: Seen[] = []
const last = () => seen[seen.length - 1]

const page1 = [
  readerDoc({ id: 'a1', updated_at: '2026-01-03T00:00:00Z' }),
  // a highlight and a note ride along in the same listing; documents must not include them
  readerDoc({ id: 'h1', category: 'highlight', parent_id: 'a1', content: '  the passage  ', notes: '', title: null }),
  readerDoc({ id: 'h2', category: 'highlight', parent_id: 'a1', content: 'another', notes: ' my note ' }),
  readerDoc({ id: 'n1', category: 'note', parent_id: 'h1', content: 'a note' }),
]
const page2 = [readerDoc({ id: 'a2', updated_at: '2026-01-02T00:00:00Z' })]

let flakyLeft = 1
const server = http.createServer(async (req, res) => {
  let raw = ''
  for await (const c of req) raw += c
  const url = new URL(req.url ?? '/', 'http://fake')
  seen.push({
    method: req.method ?? '',
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    auth: req.headers.authorization,
    contentType: req.headers['content-type'],
    body: raw ? JSON.parse(raw) : null,
  })
  const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(data))
  }
  if (req.headers.authorization !== 'Token good') return json(401, { detail: 'Invalid token.' })
  const q = Object.fromEntries(url.searchParams)

  if (req.method === 'GET' && url.pathname === '/v3/list/') {
    if (q.id) {
      const html = q.id === 'with-html' ? '  <p>Hello</p>\n' : q.id === 'no-html' ? '' : null
      const results = html == null ? [] : [readerDoc({ id: q.id, html_content: html })]
      return json(200, { count: results.length, results, nextPageCursor: null })
    }
    if (q.pageCursor === 'cursor-2') return json(200, { count: 5, results: page2, nextPageCursor: null })
    return json(200, { count: 5, results: page1, nextPageCursor: 'cursor-2' })
  }
  if (req.method === 'PATCH' && url.pathname.startsWith('/v3/update/')) {
    if (url.pathname === '/v3/update/flaky/' && flakyLeft-- > 0) return json(429, { detail: 'slow down' }, { 'Retry-After': '0' })
    if (url.pathname === '/v3/update/always-busy/') return json(429, { detail: 'slow down' }, { 'Retry-After': '0' })
    return json(200, { id: url.pathname.split('/')[3], ...(seen[seen.length - 1].body as object) })
  }
  if (req.method === 'POST' && url.pathname === '/v2/highlights/') {
    const { highlights } = last().body as { highlights: { text: string }[] }
    if (highlights[0].text === 'boom') return json(500, { detail: 'kaboom' })
    if (highlights[0].text === 'no id') return json(200, [{ id: 7, title: 'A Title', modified_highlights: [] }])
    return json(200, [{ id: 7, title: 'A Title', modified_highlights: [123] }])
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/v2/highlights/')) {
    res.writeHead(204)
    return res.end()
  }
  json(404, { detail: 'no such route' })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
const opts = { readerBase: `${base}/v3`, readwiseBase: `${base}/v2` }
const lib = readwiseLibrary('good', opts)

try {
  // ---- listDocuments: the query it sends, the pages it walks, what it filters ----
  {
    const first = await lib.listDocuments({ location: 'later', updatedAfter: '2026-01-01T00:00:00Z' })
    assert.equal(last().method, 'GET')
    assert.equal(last().path, '/v3/list/')
    assert.equal(last().auth, 'Token good')
    assert.deepEqual(last().query, { location: 'later', updatedAfter: '2026-01-01T00:00:00Z' })
    assert.deepEqual(first.items.map((d) => d.id), ['a1'], 'highlights and notes leaked into the document list')
    assert.equal(first.items[0].title, 'A Title')
    assert.equal(first.nextCursor, 'cursor-2')

    const second = await lib.listDocuments({ location: 'later', cursor: first.nextCursor! })
    assert.deepEqual(last().query, { location: 'later', pageCursor: 'cursor-2' })
    assert.deepEqual(second.items.map((d) => d.id), ['a2'])
    assert.equal(second.nextCursor, null)

    // no updatedAfter, no cursor: neither key is sent
    await lib.listDocuments({ location: 'new' })
    assert.deepEqual(last().query, { location: 'new' })
  }

  // ---- listHighlights: asks for the highlight category, keeps only placed highlights ----
  {
    const page = await lib.listHighlights({ updatedAfter: '2026-01-01T00:00:00Z' })
    assert.deepEqual(last().query, { category: 'highlight', updatedAfter: '2026-01-01T00:00:00Z' })
    assert.deepEqual(page.items, [
      { id: 'h1', docId: 'a1', text: 'the passage', note: null, updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'h2', docId: 'a1', text: 'another', note: 'my note', updatedAt: '2026-01-01T00:00:00Z' },
    ])
    assert.equal(page.nextCursor, 'cursor-2')
    await lib.listHighlights({ cursor: 'cursor-2' })
    assert.deepEqual(last().query, { category: 'highlight', pageCursor: 'cursor-2' })
  }

  // ---- fetchHtml ----
  {
    const withHtml = await lib.fetchHtml('with-html')
    assert.deepEqual(last().query, { id: 'with-html', withHtmlContent: 'true' })
    assert.equal(withHtml.html, '<p>Hello</p>')
    assert.equal(withHtml.doc.id, 'with-html')

    const noHtml = await lib.fetchHtml('no-html')
    assert.equal(noHtml.html, null, 'empty html_content should be null, not ""')
    assert.equal(noHtml.doc.title, 'A Title')

    await assert.rejects(lib.fetchHtml('missing'), /not found/)
  }

  // ---- move ----
  {
    await lib.move('a1', 'archive')
    assert.equal(last().method, 'PATCH')
    assert.equal(last().path, '/v3/update/a1/')
    assert.equal(last().contentType, 'application/json')
    assert.deepEqual(last().body, { location: 'archive' })
  }

  // ---- a 429 with Retry-After is retried once, after the wait the server named ----
  {
    const before = seen.length
    const started = Date.now()
    await lib.move('flaky', 'later')
    const patches = seen.slice(before).filter((s) => s.path === '/v3/update/flaky/')
    assert.equal(patches.length, 2, 'the throttled write was not retried')
    assert.deepEqual(patches[1].body, { location: 'later' })
    assert.ok(Date.now() - started < 2000, 'Retry-After: 0 should not wait the default five seconds')
    // throttled again on the retry: give up with a message that says so
    await assert.rejects(lib.move('always-busy', 'later'), /rate limit/)
  }

  // ---- createHighlight goes to the v2 API and reads the id out of modified_highlights ----
  {
    const doc = toLibraryDoc(readerDoc({}))
    const { remoteId } = await lib.createHighlight({ doc, text: 'a passage', note: 'why it matters' })
    assert.equal(remoteId, '123')
    assert.equal(last().method, 'POST')
    assert.equal(last().path, '/v2/highlights/')
    assert.equal(last().auth, 'Token good')
    const body = last().body as { highlights: Record<string, unknown>[] }
    assert.equal(body.highlights.length, 1)
    const h = body.highlights[0]
    assert.equal(h.text, 'a passage')
    assert.equal(h.title, 'A Title')
    assert.equal(h.author, 'An Author')
    assert.equal(h.source_url, 'https://example.com/a')
    assert.equal(h.note, 'why it matters')
    assert.equal(h.category, 'articles')
    assert.equal(typeof h.source_type, 'string')
    assert.ok(!Number.isNaN(Date.parse(h.highlighted_at as string)))

    // books are books; an empty note and missing author/url are left out rather than sent as null
    const epub = toLibraryDoc(readerDoc({ category: 'epub', author: null, source_url: null }))
    await lib.createHighlight({ doc: epub, text: 'from a book', note: '' })
    const b = (last().body as { highlights: Record<string, unknown>[] }).highlights[0]
    assert.equal(b.category, 'books')
    assert.ok(!('note' in b) && !('author' in b) && !('source_url' in b))

    await assert.rejects(lib.createHighlight({ doc, text: 'no id' }), /no id/)
    await assert.rejects(lib.createHighlight({ doc, text: 'boom' }), /POST failed \(500\).*kaboom/)
  }

  // ---- deleteHighlight ----
  {
    await lib.deleteHighlight('123')
    assert.equal(last().method, 'DELETE')
    assert.equal(last().path, '/v2/highlights/123/')
  }

  // ---- every request carried the token ----
  assert.ok(seen.every((s) => s.auth === 'Token good'))

  // ---- a bad token is reported as such, not as a generic failure ----
  {
    const bad = readwiseLibrary('bad', opts)
    await assert.rejects(bad.listDocuments({ location: 'new' }), /rejected the token/)
    await assert.rejects(bad.createHighlight({ doc: toLibraryDoc(readerDoc({})), text: 'x' }), /rejected the token/)
    assert.equal(last().auth, 'Token bad')
  }
} finally {
  server.close()
}

console.log('readwise.check: ok')
