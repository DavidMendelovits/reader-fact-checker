// The library on the phone: a cached copy of what Reader has, searchable by
// voice without a round-trip, refreshed incrementally. Also where highlights
// written on the phone get pushed to the library and retried until they land.
//
// Takes its Library and its storage as ports, so the self-check runs it under
// node with a fake Reader and a Map.
import type { KeyValueStore, Library } from './ports'
import type { DocState, Highlight, LibraryDoc, Location, RemoteHighlight } from './types'

const DOCS_KEY = 'library:docs'
const HIGHLIGHTS_KEY = 'library:highlights'
const SYNC_KEY = 'library:sync'
const docKey = (id: string) => `doc:${id}`

// Pages per location on a full sync: 100 docs a page, so the first 300 of each.
// A voice query beyond that is the sync's problem, not the reader's.
const MAX_PAGES = 3
const SYNC_LOCATIONS: Location[] = ['new', 'later', 'archive']

export interface SyncState {
  /** ISO time of the last completed sync; the next one asks only for changes since. */
  lastSync: string | null
}

export class LibraryService {
  docs: LibraryDoc[] = []
  remoteHighlights: RemoteHighlight[] = []
  sync: SyncState = { lastSync: null }
  onChange: () => void = () => {}

  constructor(
    private library: Library,
    private store: KeyValueStore,
  ) {}

  /** Restore the cached library. Instant; the sync that follows fills in changes. */
  async load(): Promise<void> {
    const [docs, highlights, sync] = await Promise.all([
      this.store.get(DOCS_KEY),
      this.store.get(HIGHLIGHTS_KEY),
      this.store.get(SYNC_KEY),
    ])
    this.docs = docs ? (JSON.parse(docs) as LibraryDoc[]) : []
    this.remoteHighlights = highlights ? (JSON.parse(highlights) as RemoteHighlight[]) : []
    this.sync = sync ? (JSON.parse(sync) as SyncState) : { lastSync: null }
    this.onChange()
  }

  private async persist(): Promise<void> {
    await Promise.all([
      this.store.set(DOCS_KEY, JSON.stringify(this.docs)),
      this.store.set(HIGHLIGHTS_KEY, JSON.stringify(this.remoteHighlights)),
      this.store.set(SYNC_KEY, JSON.stringify(this.sync)),
    ])
  }

  /**
   * Pull changes. A first sync walks each location; later ones ask for documents
   * updated since the last, which also carries anything that moved between
   * locations. `full` forgets what's cached and starts over.
   */
  async refresh(opts: { full?: boolean } = {}): Promise<void> {
    const since = opts.full ? undefined : (this.sync.lastSync ?? undefined)
    const startedAt = new Date().toISOString()
    const byId = new Map(opts.full ? [] : this.docs.map((d) => [d.id, d]))
    for (const location of SYNC_LOCATIONS) {
      let cursor: string | undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await this.library.listDocuments({ location, updatedAfter: since, cursor })
        for (const d of res.items) byId.set(d.id, d)
        if (!res.nextCursor) break
        cursor = res.nextCursor
      }
    }
    const remote = new Map(opts.full ? [] : this.remoteHighlights.map((h) => [h.id, h]))
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.library.listHighlights({ updatedAfter: since, cursor })
      for (const h of res.items) remote.set(h.id, h)
      if (!res.nextCursor) break
      cursor = res.nextCursor
    }
    this.docs = [...byId.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    this.remoteHighlights = [...remote.values()]
    this.sync = { lastSync: startedAt }
    await this.persist()
    this.onChange()
  }

  inLocation(location: Location): LibraryDoc[] {
    return this.docs.filter((d) => d.location === location)
  }

  byId(id: string): LibraryDoc | undefined {
    return this.docs.find((d) => d.id === id)
  }

  /**
   * Find documents by title, author, or a word from the summary. Spoken
   * queries are loose — "the Hemingway one", "that article about sleep" — so
   * this scores token overlap rather than demanding a substring.
   */
  search(query: string, limit = 6): LibraryDoc[] {
    const terms = tokens(query).filter((t) => !STOP.has(t))
    if (terms.length === 0) return []
    return this.docs
      .map((d) => ({ d, score: score(d, terms) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (a.d.updatedAt < b.d.updatedAt ? 1 : -1))
      .slice(0, limit)
      .map((x) => x.d)
  }

  async move(id: string, location: Location): Promise<void> {
    const doc = this.byId(id)
    if (!doc) throw new Error('That document is not in the library.')
    const before = doc.location
    doc.location = location // optimistic; the screen updates now
    this.onChange()
    try {
      await this.library.move(id, location)
      await this.persist()
    } catch (e) {
      doc.location = before
      this.onChange()
      throw e
    }
  }

  // ---- per-document state ----

  async docState(id: string): Promise<DocState> {
    const raw = await this.store.get(docKey(id))
    return raw
      ? (JSON.parse(raw) as DocState)
      : { position: 0, highlights: [], mergedRemote: [], updatedAt: 0 }
  }

  async saveDocState(id: string, state: DocState): Promise<void> {
    state.updatedAt = Date.now()
    await this.store.set(docKey(id), JSON.stringify(state))
  }

  /** Reader's highlights for a document that the phone hasn't folded in yet. */
  newRemoteHighlights(docId: string, state: DocState): RemoteHighlight[] {
    const seen = new Set(state.mergedRemote)
    const known = new Set(state.highlights.map((h) => h.remoteId).filter(Boolean))
    return this.remoteHighlights.filter((h) => h.docId === docId && !seen.has(h.id) && !known.has(h.id))
  }

  /**
   * Push a highlight to the library. On failure it stays marked pending and
   * `flush` retries it later; the reader never waits on the network to paint.
   */
  async pushHighlight(doc: LibraryDoc, h: Highlight): Promise<Highlight> {
    try {
      const { remoteId } = await this.library.createHighlight({ doc, text: h.text, note: h.note })
      return { ...h, remoteId, pending: undefined }
    } catch (e) {
      console.warn('highlight not written to Readwise yet', e)
      return { ...h, pending: 'create' }
    }
  }

  async removeHighlight(h: Highlight): Promise<Highlight | null> {
    if (!h.remoteId) return null // never left the phone
    try {
      await this.library.deleteHighlight(h.remoteId)
      return null
    } catch (e) {
      console.warn('highlight not removed from Readwise yet', e)
      return { ...h, pending: 'delete' }
    }
  }

  /** Retry whatever didn't land. Returns the state with the results folded in. */
  async flush(doc: LibraryDoc, state: DocState): Promise<DocState> {
    const out: Highlight[] = []
    for (const h of state.highlights) {
      if (h.pending === 'create') out.push(await this.pushHighlight(doc, h))
      else if (h.pending === 'delete') {
        const left = await this.removeHighlight(h)
        if (left) out.push(left)
      } else out.push(h)
    }
    return { ...state, highlights: out }
  }
}

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'by', 'and', 'or', 'that', 'this', 'one', 'about', 'book', 'article', 'open', 'read', 'me', 'my', 'please'])
const tokens = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9']+/g) ?? []

function score(d: LibraryDoc, terms: string[]): number {
  const title = tokens(d.title)
  const author = tokens(d.author ?? '')
  const summary = tokens(d.summary ?? '')
  let s = 0
  for (const t of terms) {
    if (title.includes(t)) s += 3
    else if (title.some((w) => w.startsWith(t) && t.length >= 4)) s += 2
    if (author.includes(t)) s += 3
    else if (author.some((w) => w.startsWith(t) && t.length >= 3)) s += 2
    if (summary.includes(t)) s += 1
  }
  // every term matched somewhere: a bonus, so "hemingway sea" beats a doc that only has "sea"
  if (terms.every((t) => title.includes(t) || author.includes(t) || summary.includes(t))) s += 2
  return s
}
