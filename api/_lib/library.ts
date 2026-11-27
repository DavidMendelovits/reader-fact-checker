// The /api/library use-case: the reader's library, read through whichever
// adapter providers().library names, with the token the caller sent. Only
// reads for now; the web app keeps its highlights to itself until writing
// them back is its own change.
//
// Ids, cursors and dates come from the model or the browser, so each is
// checked before it can reach an adapter.
import type { LibraryDoc, Location, Page, RemoteHighlight } from '../../shared/library/types.js'
import { NoLibraryToken, providers } from './providers.js'

export type LibraryRequest =
  | { op: 'list'; location: Location; updatedAfter?: string; cursor?: string }
  | { op: 'html'; id: string }
  | { op: 'highlights'; updatedAfter?: string; cursor?: string }

export type LibraryResponse =
  | Page<LibraryDoc>
  | Page<RemoteHighlight>
  | { doc: LibraryDoc; html: string | null }

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
      default:
        throw new LibraryError('op must be list, html or highlights', 400)
    }
  } catch (e) {
    if (e instanceof Error && /rejected the token/.test(e.message)) throw new LibraryError(e.message, 401)
    throw e
  }
}
