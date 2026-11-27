// The /api/library use-case: the reader's library, read through whichever
// adapter providers().library names, with the token the caller sent. Reads,
// plus the one write the web app needs: a highlight made on a Reader document
// goes to Readwise, and one removed comes out again.
//
// Ids, cursors and dates come from the model or the browser, so each is
// checked before it can reach an adapter.
import type { LibraryDoc, Location, Page, RemoteHighlight } from '../../shared/library/types.js'
import { NoLibraryToken, providers } from './providers.js'

export type LibraryRequest =
  | { op: 'list'; location: Location; updatedAfter?: string; cursor?: string }
  | { op: 'html'; id: string }
  | { op: 'highlights'; updatedAfter?: string; cursor?: string }
  | { op: 'createHighlight'; doc: HighlightDoc; text: string; note?: string; location?: number }
  | { op: 'deleteHighlight'; remoteId: string }

/** What Readwise files a highlight under: the document's title, author, link and kind. */
export type HighlightDoc = Pick<LibraryDoc, 'title' | 'author' | 'sourceUrl' | 'category'>

export type LibraryResponse =
  | Page<LibraryDoc>
  | Page<RemoteHighlight>
  | { doc: LibraryDoc; html: string | null }
  | { remoteId: string }
  | { ok: true }

/** A request the caller got wrong: 400 for a bad body, 401 for a missing or refused token. */
export class LibraryError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

const LOCATIONS = new Set(['new', 'later', 'archive', 'feed'])
const ID = /^[A-Za-z0-9_-]{1,64}$/
const CURSOR = /^[A-Za-z0-9_=+/.:-]{1,256}$/
const optional = (v: unknown, ok: (s: string) => boolean, name: string): string | undefined => {
  if (v == null || v === '') return undefined
  if (typeof v !== 'string' || !ok(v)) throw new LibraryError(`bad ${name}`, 400)
  return v
}
const cursor = (v: unknown) => optional(v, (s) => CURSOR.test(s), 'cursor')
const since = (v: unknown) => optional(v, (s) => !Number.isNaN(Date.parse(s)), 'updatedAfter')
// Readwise caps a highlight at 8,191 characters and a title or author at 511.
const text = (v: unknown, max: number, name: string): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new LibraryError(`bad ${name}`, 400)
  return v
}
// an optional field Readwise would refuse is left off, not a reason to lose the highlight
const orNull = (v: unknown, ok: (s: string) => boolean): string | null => (typeof v === 'string' && ok(v) ? v : null)
const isLink = (s: string) => {
  try {
    return s.length <= 2048 && /^https?:$/.test(new URL(s).protocol)
  } catch {
    return false
  }
}

function highlightDoc(v: unknown): HighlightDoc {
  const d = (v ?? {}) as Record<string, unknown>
  return {
    title: text(d.title, 511, 'title'),
    author: orNull(d.author, (s) => !!s.trim() && s.length <= 511),
    sourceUrl: orNull(d.sourceUrl, isLink),
    category: orNull(d.category, (s) => /^[a-z_]{1,20}$/.test(s)),
  }
}

export async function libraryRequest(body: unknown, token: string | null): Promise<LibraryResponse> {
  const req = (body ?? {}) as Record<string, unknown>
  let lib
  try {
    lib = providers().library(token?.trim() || null)
  } catch (e) {
    if (e instanceof NoLibraryToken) throw new LibraryError(e.message, 401)
    throw e
  }
  try {
    switch (req.op) {
      case 'list': {
        if (typeof req.location !== 'string' || !LOCATIONS.has(req.location)) throw new LibraryError('bad location', 400)
        return await lib.listDocuments({ location: req.location as Location, updatedAfter: since(req.updatedAfter), cursor: cursor(req.cursor) })
      }
      case 'html': {
        if (typeof req.id !== 'string' || !ID.test(req.id)) throw new LibraryError('bad id', 400)
        return await lib.fetchHtml(req.id)
      }
      case 'highlights':
        return await lib.listHighlights({ updatedAfter: since(req.updatedAfter), cursor: cursor(req.cursor) })
      case 'createHighlight': {
        const location = req.location == null ? undefined : req.location
        if (location !== undefined && !(Number.isSafeInteger(location) && (location as number) >= 0)) throw new LibraryError('bad location', 400)
        return await lib.createHighlight({
          // the adapter reads only these four; the rest of LibraryDoc is the phone's
          doc: highlightDoc(req.doc) as LibraryDoc,
          text: text(req.text, 8191, 'text'),
          note: req.note == null || req.note === '' ? undefined : text(req.note, 8191, 'note'),
          location: location as number | undefined,
        })
      }
      case 'deleteHighlight': {
        if (typeof req.remoteId !== 'string' || !ID.test(req.remoteId)) throw new LibraryError('bad remoteId', 400)
        await lib.deleteHighlight(req.remoteId)
        return { ok: true }
      }
      default:
        throw new LibraryError('op must be list, html, highlights, createHighlight or deleteHighlight', 400)
    }
  } catch (e) {
    if (e instanceof Error && /rejected the token/.test(e.message)) throw new LibraryError(e.message, 401)
    throw e
  }
}
