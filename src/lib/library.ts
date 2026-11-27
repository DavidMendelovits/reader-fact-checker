// The reader's Readwise library, on the web. The browser never talks to
// Readwise: /api/library does, with the token the reader pasted, and the same
// adapter the phone uses (shared/library/readwise.ts). What comes back is
// cached here so a spoken "switch to the Hemingway one" is answered from
// memory, and refreshed incrementally like the phone's.
//
// The token lives in this browser only. It goes with each library request and
// is never stored on the server.
import { htmlToChapters } from '../../shared/library/html.ts'
import type { Chapter, LibraryDoc, Location, Page, RemoteHighlight } from '../../shared/library/types.ts'
import { ApiError, apiFetch } from './api'

const TOKEN_KEY = 'rfc-readwise-token'
const CACHE_KEY = 'rfc-readwise-cache'
// Same reach as the phone: 100 documents a page, the first 300 of each shelf.
const MAX_PAGES = 3
const SHELVES: Location[] = ['new', 'later', 'archive']

interface Cache {
  docs: LibraryDoc[]
  highlights: RemoteHighlight[]
  /** ISO time of the last completed sync; the next one asks only for changes since. */
  lastSync: string | null
}

const empty = (): Cache => ({ docs: [], highlights: [], lastSync: null })

function readCache(): Cache {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as Cache | null
    return raw && Array.isArray(raw.docs) && Array.isArray(raw.highlights) ? raw : empty()
  } catch {
    return empty()
  }
}

let cache: Cache = typeof localStorage === 'undefined' ? empty() : readCache()
/** Why the last sync failed, when it did; cleared by the next one that works. */
let lastError: string | null = null
let syncing: Promise<void> | null = null
/** Bumped when the token changes, so a sync still running for the old one drops its result. */
let generation = 0

export function readwiseToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

/** Save or forget the token. A new token is a new library, so the cache goes too. */
export function setReadwiseToken(token: string | null) {
  try {
    if (token?.trim()) localStorage.setItem(TOKEN_KEY, token.trim())
    else localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(CACHE_KEY)
  } catch {
    /* storage blocked: the token lasts as long as the page */
  }
  cache = empty()
  lastError = null
  generation++
  syncing = null // a new token starts its own sync rather than joining the old one
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const token = readwiseToken()
  const res = await apiFetch('/api/library', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Readwise-Token': token } : {}) },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.json().then((j: { error?: string }) => j.error, () => null)
    throw new ApiError(detail || `The library failed (${res.status})`, res.status)
  }
  return res.json() as Promise<T>
}

/**
 * Pull what changed since the last sync: each shelf, then the highlights. A
 * second call while one runs waits for it rather than starting another, since
 * Reader allows 20 list calls a minute.
 */
export function refreshLibrary(): Promise<void> {
  syncing ??= (async () => {
    const gen = generation
    const since = cache.lastSync ?? undefined
    const startedAt = new Date().toISOString()
    try {
      const docs = new Map(cache.docs.map((d) => [d.id, d]))
      for (const location of SHELVES) {
        let cursor: string | undefined
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await call<Page<LibraryDoc>>({ op: 'list', location, updatedAfter: since, cursor })
          for (const d of res.items) docs.set(d.id, d)
          if (!res.nextCursor) break
          cursor = res.nextCursor
        }
      }
      const highlights = new Map(cache.highlights.map((h) => [h.id, h]))
      let cursor: string | undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await call<Page<RemoteHighlight>>({ op: 'highlights', updatedAfter: since, cursor })
        for (const h of res.items) highlights.set(h.id, h)
        if (!res.nextCursor) break
        cursor = res.nextCursor
      }
      if (gen !== generation) return // the token changed mid-sync
      cache = {
        docs: [...docs.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
        highlights: [...highlights.values()],
        lastSync: startedAt,
      }
      lastError = null
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
      } catch {
        // ponytail: shares the ~5MB with saved books (persist.ts); a few hundred
        // documents is well under a megabyte. Move both to IndexedDB if it bites.
      }
    } catch (e) {
      if (gen === generation) lastError = e instanceof Error ? e.message : String(e)
    } finally {
      if (gen === generation) syncing = null
    }
  })()
  return syncing
}

const STALE_MS = 10 * 60 * 1000

/**
 * The cached library, synced first if it never has been (or the last try
 * failed). A cache older than ten minutes answers now and refreshes behind.
 * With no token there is no library to sync.
 */
export async function library(): Promise<{ docs: LibraryDoc[]; highlights: RemoteHighlight[]; error: string | null }> {
  if (!readwiseToken()) return { docs: [], highlights: [], error: null } // not connected: what's saved here is the library
  if (!cache.lastSync) await refreshLibrary()
  else if (Date.now() - Date.parse(cache.lastSync) > STALE_MS) void refreshLibrary()
  return { docs: cache.docs, highlights: cache.highlights, error: cache.lastSync ? null : lastError }
}

/** What the screen shows without waiting on a sync. */
export const librarySnapshot = () => ({ docs: cache.docs.length, synced: cache.lastSync != null, error: lastError })

/**
 * A document's text, split into chapters the way the phone splits it, so a
 * paragraph index means the same passage in both apps.
 */
export async function fetchChapters(id: string): Promise<{ doc: LibraryDoc; chapters: Chapter[] }> {
  const { doc, html } = await call<{ doc: LibraryDoc; html: string | null }>({ op: 'html', id })
  if (!html) throw new Error(`Reader has no readable text for "${doc.title}" (it may be a PDF or a video).`)
  const chapters = htmlToChapters(html, doc.title).filter((c) => c.paragraphs.length > 0)
  if (chapters.length === 0) throw new Error(`"${doc.title}" has no readable text.`)
  return { doc, chapters }
}

/** A Reader document from the cache, by Reader's own id. */
export const libraryDoc = (id: string): LibraryDoc | undefined => cache.docs.find((d) => d.id === id)

/** Write one highlight to Readwise, filed under the document. */
export async function createRemoteHighlight(doc: LibraryDoc, h: { text: string; note?: string; location?: number }): Promise<string> {
  const { title, author, sourceUrl, category } = doc
  const { remoteId } = await call<{ remoteId: string }>({ op: 'createHighlight', doc: { title, author, sourceUrl, category }, ...h })
  return remoteId
}

export async function deleteRemoteHighlight(remoteId: string): Promise<void> {
  await call<{ ok: true }>({ op: 'deleteHighlight', remoteId })
}
