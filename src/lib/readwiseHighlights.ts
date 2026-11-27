// Highlights made on a Reader document go to Readwise, the way the phone's do
// (mobile/src/library.ts). A thought with skipped words goes as its runs, tagged
// .c1, .c2 so Readwise joins them back into one highlight (concat.ts).
//
// Nothing waits on the network: a highlight is saved here at once, marked
// pending, and written behind. One that fails stays pending and is tried again
// when the document is next opened or the browser comes back online. Removing a
// highlight removes what landed; a removal that fails is queued and retried.
//
// Only highlights made after this shipped are marked, so older ones in this
// browser never turn up in Readwise unasked.
//
// ponytail: two gaps, both shared with the phone. A write whose answer is lost
// is sent again on retry, which can duplicate it in Readwise. And Readwise ids
// don't record which token wrote them, so a removal after switching Readwise
// accounts goes to the new account, gets a 404, and is dropped.
import { concatenated, readwiseNote } from '../../shared/library/concat.ts'
import type { LibraryDoc } from '../../shared/library/types.ts'
import type { Doc, Highlight } from '../types'

export const READWISE = 'readwise:'
const DELETES_KEY = 'rfc-readwise-deletes'
/** A removal queue longer than this means something is stuck; the oldest go. */
const MAX_QUEUED = 200
/** Readwise's longest highlight; /api/library refuses more. */
const MAX_TEXT = 8191

/** Mark a new highlight for Readwise: only on a Reader document, and only with a token saved. */
export function forReadwise(h: Highlight, parts: string[], docId: string | undefined, hasToken: boolean): Highlight {
  if (!docId?.startsWith(READWISE) || !hasToken) return h
  // ponytail: past Readwise's cap a highlight could never land, so it stays here
  // rather than retrying forever (8 is room for the .cN tag on the note)
  if ((parts.length ? parts : [h.text]).some((p) => p.length > MAX_TEXT) || (h.note?.length ?? 0) > MAX_TEXT - 8) return h
  return { ...h, pending: true, parts: parts.length > 1 ? parts : undefined }
}

const isRefusal = (e: unknown) => (e as { status?: unknown })?.status === 400

/**
 * The order Readwise keeps a document's highlights in: the paragraph, then the
 * run. The paragraph scale matches the phone's; within a paragraph the phone
 * uses the character offset, which the web doesn't keep.
 */
export const location = (anchor: number, run: number) => anchor * 10000 + run

interface Snapshot {
  doc: Doc | null
  highlights: Highlight[]
}

export interface SyncDeps {
  getState(): Snapshot
  subscribe(listener: (s: Snapshot, prev: Snapshot) => void): void
  setHighlights(hs: Highlight[]): void
  /** Change a saved, closed document's highlights. False when no entry is saved for it. */
  patchSaved(docId: string, change: (hs: Highlight[]) => Highlight[]): boolean
  hasToken(): boolean
  libraryDoc(readerId: string): LibraryDoc | undefined
  create(doc: LibraryDoc, h: { text: string; note?: string; location: number }): Promise<string>
  remove(remoteId: string): Promise<void>
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
}

export class HighlightSync {
  private chain: Promise<void> = Promise.resolve()
  /** Highlights the reader removed this session, so a write that lands later knows to undo itself. */
  private removed = new Set<string>()
  constructor(private deps: SyncDeps) {}

  /** Watch the store: a new pending highlight or a newly opened document starts a sync; a removal takes its runs out. */
  start() {
    this.deps.subscribe((s, prev) => {
      if (s.highlights === prev.highlights && s.doc === prev.doc) return
      if (s.doc !== prev.doc) return void this.sync() // an opened document's leftovers, once its highlights are in
      const was = new Set(prev.highlights.map((h) => h.id))
      const now = new Set(s.highlights.map((h) => h.id))
      const dropped = prev.highlights.filter((h) => !now.has(h.id))
      for (const h of dropped) this.removed.add(h.id)
      const gone = dropped.flatMap((h) => h.remoteIds ?? [])
      if (gone.length) this.queueDeletes(gone)
      if (gone.length || s.highlights.some((h) => h.pending && !was.has(h.id))) void this.sync()
    })
    return this
  }

  /** One sync at a time, so a thought's runs reach Readwise in order and a retry can't race a first try. */
  sync(): Promise<void> {
    this.chain = this.chain.then(() => this.run())
    return this.chain
  }

  private async run() {
    if (!this.deps.hasToken()) return
    await this.retryDeletes()
    const { doc, highlights } = this.deps.getState()
    if (!doc?.id.startsWith(READWISE)) return
    const reader = this.deps.libraryDoc(doc.id.slice(READWISE.length))
    // ponytail: not in the cached library (past its first 300 a shelf) means no
    // title to file it under; it stays pending until a sync brings the doc in.
    if (!reader) return
    // the store keeps newest first; Readwise should get them in the order they were made
    for (const h of highlights.filter((x) => x.pending).reverse()) await this.push(doc.id, reader, h)
  }

  private async push(docId: string, reader: LibraryDoc, h: Highlight) {
    const runs = concatenated(h.parts ?? [h.text], h.note)
    const ids = [...(h.remoteIds ?? [])]
    let refused = false
    for (let i = ids.length; i < runs.length; i++) {
      try {
        const r = runs[i]
        ids.push(await this.deps.create(reader, { text: r.text, note: readwiseNote(r.note, r.concat), location: location(h.anchor, i) }))
      } catch (e) {
        // a refusal (400) never changes on retry; anything else is tried again later
        if (isRefusal(e)) {
          console.warn('Readwise refused this highlight; it stays in this browser', e)
          refused = true
        } else console.warn('highlight not written to Readwise yet', e)
        break
      }
    }
    const done = refused || ids.length === runs.length
    if (!this.patch(docId, h.id, { remoteIds: ids, pending: done ? undefined : true })) {
      this.queueDeletes(ids) // removed while it was being written
      await this.retryDeletes()
    }
  }

  /** Apply what landed to the highlight, open or saved. False when the reader removed it meanwhile. */
  private patch(docId: string, id: string, fields: Partial<Highlight>): boolean {
    const change = (hs: Highlight[]) => hs.map((h) => (h.id === id ? { ...h, ...fields } : h))
    const { doc, highlights } = this.deps.getState()
    if (doc?.id === docId) this.deps.setHighlights(change(highlights))
    else this.deps.patchSaved(docId, change)
    // Only a removal undoes the write. A saved entry that lacks the highlight
    // for another reason (evicted for space) keeps its runs in Readwise.
    return !this.removed.has(id)
  }

  /** The removal queue: kept in memory too, since storage fills up with saved books (persist.ts). */
  private queue: string[] | null = null

  private readQueue(): string[] {
    if (this.queue) return this.queue
    try {
      const q = JSON.parse(this.deps.storage?.getItem(DELETES_KEY) ?? '[]')
      this.queue = Array.isArray(q) ? q.filter((x): x is string => typeof x === 'string') : []
    } catch {
      this.queue = []
    }
    return this.queue
  }

  private writeQueue(q: string[]) {
    this.queue = q.slice(-MAX_QUEUED)
    try {
      this.deps.storage?.setItem(DELETES_KEY, JSON.stringify(this.queue))
    } catch {
      /* storage full or blocked: the removal is still tried this session */
    }
  }

  private queueDeletes(ids: string[]) {
    if (ids.length) this.writeQueue([...new Set([...this.readQueue(), ...ids])])
  }

  private async retryDeletes() {
    const tried = this.readQueue()
    if (!tried.length) return
    const left = new Set<string>()
    for (const id of tried) {
      try {
        await this.deps.remove(id)
      } catch (e) {
        console.warn('highlight not removed from Readwise yet', e)
        left.add(id)
      }
    }
    // keep what failed, and anything queued while these ran
    this.writeQueue(this.readQueue().filter((id) => left.has(id) || !tried.includes(id)))
  }
}
