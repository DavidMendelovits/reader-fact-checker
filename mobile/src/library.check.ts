// Self-check for the on-phone library. Run it with:
//
//   node --experimental-strip-types src/library.check.ts
//
// The library is what the voice searches and what highlights are written
// through, and it has to stay right across syncs: an incremental refresh that
// forgets to send `updatedAfter` re-downloads everything; one that mishandles
// a moved document shows it in two places; a failed move that isn't rolled
// back lies on the screen; a highlight write that fails and isn't marked
// pending is lost. A fake Library and a Map stand in for Reader and the phone.
import assert from 'node:assert/strict'
import { LibraryService } from './library.ts'
import type { KeyValueStore, Library, Page } from './ports.ts'
import type { DocState, Highlight, LibraryDoc, Location, RemoteHighlight } from './types.ts'

const doc = (id: string, over: Partial<LibraryDoc> = {}): LibraryDoc => ({
  id,
  title: `Title ${id}`,
  author: null,
  category: 'article',
  location: 'new',
  sourceUrl: null,
  wordCount: null,
  summary: null,
  tags: [],
  readingProgress: null,
  publishedDate: null,
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
})
const at = (day: number) => `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`
const remote = (id: string, docId: string): RemoteHighlight => ({ id, docId, text: `text ${id}`, note: null, updatedAt: '2026-01-01T00:00:00Z' })
const highlight = (id: string, over: Partial<Highlight> = {}): Highlight => ({ id, text: `passage ${id}`, anchor: null, createdAt: 1, ...over })

class FakeLibrary implements Library {
  /** Pages per location; a cursor is the index of the next page. */
  pages: Partial<Record<Location, LibraryDoc[][]>> = {}
  highlightPages: RemoteHighlight[][] = [[]]
  listCalls: { location: Location; updatedAfter?: string; cursor?: string }[] = []
  highlightCalls: { updatedAfter?: string; cursor?: string }[] = []
  moves: [string, Location][] = []
  created: { docId: string; text: string; note?: string }[] = []
  deleted: string[] = []
  failMove = false
  failCreate = false
  failDelete = false
  private nextId = 1

  private page<T>(pages: T[][], cursor?: string): Page<T> {
    const i = cursor ? Number(cursor) : 0
    return { items: pages[i] ?? [], nextCursor: i + 1 < pages.length ? String(i + 1) : null }
  }
  async listDocuments(opts: { location: Location; updatedAfter?: string; cursor?: string }) {
    this.listCalls.push({ ...opts })
    return this.page(this.pages[opts.location] ?? [[]], opts.cursor)
  }
  async fetchHtml(id: string) {
    return { doc: doc(id), html: null }
  }
  async move(id: string, location: Location) {
    if (this.failMove) throw new Error('offline')
    this.moves.push([id, location])
  }
  async listHighlights(opts: { updatedAfter?: string; cursor?: string }) {
    this.highlightCalls.push({ ...opts })
    return this.page(this.highlightPages, opts.cursor)
  }
  async createHighlight({ doc, text, note }: { doc: LibraryDoc; text: string; note?: string }) {
    if (this.failCreate) throw new Error('offline')
    this.created.push({ docId: doc.id, text, note })
    return { remoteId: `rem-${this.nextId++}` }
  }
  async deleteHighlight(remoteId: string) {
    if (this.failDelete) throw new Error('offline')
    this.deleted.push(remoteId)
  }
}

class MemoryStore implements KeyValueStore {
  map = new Map<string, string>()
  async get(key: string) {
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string) {
    this.map.set(key, value)
  }
  async remove(key: string) {
    this.map.delete(key)
  }
}

// the service warns (on purpose) when a write doesn't land; keep the check's output clean
const realWarn = console.warn
console.warn = () => {}

const fake = new FakeLibrary()
const store = new MemoryStore()
const service = new LibraryService(fake, store)
let changes = 0
service.onChange = () => changes++

// ---- load() on an empty store ----
await service.load()
assert.equal(service.docs.length, 0)
assert.equal(service.remoteHighlights.length, 0)
assert.deepEqual(service.sync, { lastSync: null })
assert.equal(changes, 1)

// ---- first refresh: walks every page of every location, and the highlights, then persists ----
fake.pages = {
  new: [[doc('a', { updatedAt: at(1) }), doc('b', { updatedAt: at(2) })], [doc('c', { updatedAt: at(3) })]],
  later: [[doc('d', { location: 'later', updatedAt: at(4) })]],
  archive: [[doc('e', { location: 'archive', updatedAt: at(5) })]],
}
fake.highlightPages = [[remote('h1', 'a'), remote('h2', 'a')], [remote('h3', 'b')]]
await service.refresh()
assert.deepEqual(fake.listCalls, [
  { location: 'new', updatedAfter: undefined, cursor: undefined },
  { location: 'new', updatedAfter: undefined, cursor: '1' },
  { location: 'later', updatedAfter: undefined, cursor: undefined },
  { location: 'archive', updatedAfter: undefined, cursor: undefined },
])
assert.deepEqual(fake.highlightCalls, [
  { updatedAfter: undefined, cursor: undefined },
  { updatedAfter: undefined, cursor: '1' },
])
assert.deepEqual(service.docs.map((d) => d.id), ['e', 'd', 'c', 'b', 'a'], 'newest first')
assert.deepEqual(service.remoteHighlights.map((h) => h.id), ['h1', 'h2', 'h3'])
assert.deepEqual(service.inLocation('later').map((d) => d.id), ['d'])
assert.equal(service.byId('c')?.title, 'Title c')
const firstSync = service.sync.lastSync
assert.ok(firstSync && !Number.isNaN(Date.parse(firstSync)), 'lastSync should be an ISO time')
// persisted: a fresh service on the same store restores the same library
{
  const again = new LibraryService(new FakeLibrary(), store)
  await again.load()
  assert.deepEqual(again.docs, service.docs)
  assert.deepEqual(again.remoteHighlights, service.remoteHighlights)
  assert.deepEqual(again.sync, { lastSync: firstSync })
}

// ---- second refresh: incremental, and a moved document merges instead of duplicating ----
fake.listCalls = []
fake.highlightCalls = []
fake.pages = {
  new: [[]],
  later: [[]],
  archive: [[doc('b', { location: 'archive', updatedAt: '2026-02-01T00:00:00Z' })]],
}
fake.highlightPages = [[{ ...remote('h2', 'a'), note: 'edited' }, remote('h4', 'b')]]
await new Promise((r) => setTimeout(r, 5))
await service.refresh()
assert.equal(fake.listCalls.length, 3)
assert.ok(fake.listCalls.every((c) => c.updatedAfter === firstSync), 'incremental sync must ask for changes since the last one')
assert.deepEqual(fake.highlightCalls, [{ updatedAfter: firstSync, cursor: undefined }])
assert.equal(service.docs.length, 5, 'a moved document was duplicated')
assert.equal(service.docs.filter((d) => d.id === 'b').length, 1)
assert.equal(service.byId('b')?.location, 'archive')
assert.equal(service.docs[0].id, 'b', 'the updated document is now the newest')
assert.deepEqual(service.inLocation('new').map((d) => d.id), ['c', 'a'])
assert.deepEqual(service.remoteHighlights.map((h) => [h.id, h.note]), [['h1', null], ['h2', 'edited'], ['h3', null], ['h4', null]])
assert.ok(service.sync.lastSync! > firstSync!)

// ---- full refresh: forgets what the library no longer has ----
fake.listCalls = []
fake.pages = { new: [[doc('a', { updatedAt: at(1) })]], later: [[doc('d', { location: 'later', updatedAt: at(4) })]], archive: [[]] }
fake.highlightPages = [[remote('h1', 'a')]]
await service.refresh({ full: true })
assert.ok(fake.listCalls.every((c) => c.updatedAfter === undefined), 'a full sync must not narrow by time')
assert.deepEqual(service.docs.map((d) => d.id), ['d', 'a'])
assert.deepEqual(service.remoteHighlights.map((h) => h.id), ['h1'])
assert.deepEqual(JSON.parse(store.map.get('library:docs')!).map((d: LibraryDoc) => d.id), ['d', 'a'])

// ---- search ----
service.docs = [
  doc('oldman', { title: 'The Old Man and the Sea', author: 'Ernest Hemingway', updatedAt: '2026-01-01T00:00:00Z' }),
  doc('seastories', { title: 'Sea Stories', author: 'William H. McRaven', updatedAt: '2026-01-05T00:00:00Z' }),
  doc('sleep', { title: 'Why We Sleep', author: 'Matthew Walker', summary: 'The science of sleep and dreams.' }),
  doc('garcia', { title: 'Cien años de soledad', author: 'Gabriel García Márquez' }),
]
const ids = (q: string, limit?: number) => service.search(q, limit).map((d) => d.id)
assert.deepEqual(ids('hemingway sea'), ['oldman', 'seastories'], '"hemingway sea" should rank the Hemingway book first')
assert.deepEqual(ids('sea'), ['seastories', 'oldman'], 'a tie on score falls back to newest first')
assert.deepEqual(ids('hemingway'), ['oldman'], 'author match')
assert.deepEqual(ids('the one by walker'), ['sleep'])
assert.deepEqual(ids('that article about dreams'), ['sleep'], 'a word from the summary')
assert.deepEqual(ids('the book'), [], 'stop words alone are no query')
assert.deepEqual(ids(''), [])
assert.deepEqual(ids('   '), [])
assert.deepEqual(ids('nothing matches this'), [])
assert.deepEqual(ids('heming'), ['oldman'], 'a prefix of the author')
assert.deepEqual(ids('stor'), ['seastories'], 'a prefix of a title word')
assert.deepEqual(ids('garcia marquez'), ['garcia'], 'accents are ignored')
assert.deepEqual(ids('sea', 1), ['seastories'], 'limit')

// ---- move: optimistic, persisted on success, rolled back on failure ----
{
  await service.refresh({ full: true }) // back to the fake's docs: a (new), d (later)
  changes = 0
  await service.move('a', 'later')
  assert.equal(service.byId('a')?.location, 'later')
  assert.deepEqual(fake.moves, [['a', 'later']])
  assert.equal(changes, 1)
  assert.equal(JSON.parse(store.map.get('library:docs')!).find((d: LibraryDoc) => d.id === 'a').location, 'later')

  fake.failMove = true
  changes = 0
  await assert.rejects(service.move('a', 'archive'), /offline/)
  assert.equal(service.byId('a')?.location, 'later', 'a failed move must roll back')
  assert.equal(changes, 2, 'the screen is told both when the move is tried and when it is undone')
  assert.equal(JSON.parse(store.map.get('library:docs')!).find((d: LibraryDoc) => d.id === 'a').location, 'later')
  fake.failMove = false

  await assert.rejects(service.move('nope', 'later'), /not in the library/)
}

// ---- per-document state ----
{
  assert.deepEqual(await service.docState('x'), { position: 0, highlights: [], mergedRemote: [], updatedAt: 0 })
  const state: DocState = { position: 12, highlights: [highlight('p1', { anchor: { paragraph: 3, start: 0, end: 5 } })], mergedRemote: ['h1'], updatedAt: 0 }
  await service.saveDocState('x', state)
  assert.ok(state.updatedAt > 0, 'saving stamps the state')
  assert.deepEqual(await service.docState('x'), state)
  assert.deepEqual(await service.docState('y'), { position: 0, highlights: [], mergedRemote: [], updatedAt: 0 })
}

// ---- newRemoteHighlights: Reader's highlights the phone hasn't seen ----
{
  service.remoteHighlights = [remote('r1', 'A'), remote('r2', 'A'), remote('r3', 'A'), remote('r4', 'B')]
  const state: DocState = {
    position: 0,
    highlights: [highlight('p1', { remoteId: 'r2' }), highlight('p2')],
    mergedRemote: ['r1'],
    updatedAt: 0,
  }
  assert.deepEqual(service.newRemoteHighlights('A', state).map((h) => h.id), ['r3'])
  assert.deepEqual(service.newRemoteHighlights('B', state).map((h) => h.id), ['r4'])
  assert.deepEqual(service.newRemoteHighlights('C', state), [])
}

// ---- pushHighlight: pending on failure, linked on success ----
{
  const target = doc('a')
  fake.failCreate = true
  const failed = await service.pushHighlight(target, highlight('p1', { note: 'n' }))
  assert.equal(failed.pending, 'create')
  assert.equal(failed.remoteId, undefined)
  assert.equal(failed.text, 'passage p1')
  assert.deepEqual(fake.created, [])

  fake.failCreate = false
  const ok = await service.pushHighlight(target, failed)
  assert.equal(ok.remoteId, 'rem-1')
  assert.equal(ok.pending, undefined)
  assert.deepEqual(fake.created, [{ docId: 'a', text: 'passage p1', note: 'n' }])
}

// ---- removeHighlight ----
{
  assert.equal(await service.removeHighlight(highlight('local')), null, 'never written: nothing to delete')
  assert.deepEqual(fake.deleted, [])

  fake.failDelete = true
  const stuck = await service.removeHighlight(highlight('p2', { remoteId: 'rem-2' }))
  assert.equal(stuck?.pending, 'delete')
  assert.equal(stuck?.remoteId, 'rem-2')
  fake.failDelete = false

  assert.equal(await service.removeHighlight(stuck!), null)
  assert.deepEqual(fake.deleted, ['rem-2'])
}

// ---- flush: retries pending creates and deletes, leaves the rest alone ----
{
  const target = doc('a')
  fake.created = []
  fake.deleted = []
  const state: DocState = {
    position: 4,
    highlights: [
      highlight('c1', { pending: 'create' }),
      highlight('d1', { remoteId: 'rem-9', pending: 'delete' }),
      highlight('ok', { remoteId: 'rem-5' }),
      highlight('d2', { pending: 'delete' }), // never written, so nothing to delete: just drop it
    ],
    mergedRemote: ['m'],
    updatedAt: 7,
  }
  const out = await service.flush(target, state)
  assert.equal(out.position, 4)
  assert.deepEqual(out.mergedRemote, ['m'])
  assert.deepEqual(out.highlights.map((h) => h.id), ['c1', 'ok'])
  assert.equal(out.highlights[0].remoteId, 'rem-2')
  assert.equal(out.highlights[0].pending, undefined)
  assert.deepEqual(out.highlights[1], highlight('ok', { remoteId: 'rem-5' }))
  assert.deepEqual(fake.created.map((c) => c.text), ['passage c1'])
  assert.deepEqual(fake.deleted, ['rem-9'])
  assert.equal(state.highlights.length, 4, 'flush returns a new state rather than mutating the old')

  // still offline: everything stays pending for the next flush
  fake.failCreate = true
  fake.failDelete = true
  const stillPending = await service.flush(target, state)
  assert.deepEqual(stillPending.highlights.map((h) => [h.id, h.pending]), [['c1', 'create'], ['d1', 'delete'], ['ok', undefined]])
  fake.failCreate = false
  fake.failDelete = false
}

// ---- each page paints as it lands: the list fills in instead of appearing at the end ----
{
  const paged = new FakeLibrary()
  paged.pages = {
    new: [[doc('p1', { updatedAt: at(1) })], [doc('p2', { updatedAt: at(2) })], [doc('p3', { updatedAt: at(3) })]],
  }
  const svc = new LibraryService(paged, new MemoryStore())
  const seen: string[][] = []
  svc.onChange = () => seen.push(svc.docs.map((d) => d.id))
  await svc.refresh()
  assert.deepEqual(seen.slice(0, 3), [['p1'], ['p2', 'p1'], ['p3', 'p2', 'p1']], 'one paint per page as it lands, newest first')
  // the other shelves' (empty) pages and the persist each repaint the full list; it never goes backwards
  assert.ok(seen.length > 3)
  for (const paint of seen.slice(3)) assert.deepEqual(paint, ['p3', 'p2', 'p1'])
}

console.warn = realWarn
console.log('library.check: ok')
