// Readwise as the Library. Two APIs behind one adapter:
//
// - Reader API v3 (https://readwise.io/reader_api) for documents: list, fetch
//   with HTML, move between locations. Highlights come back from the same list
//   endpoint as child documents of category "highlight" with a parent_id.
// - Readwise API v2 for *writing* highlights. Reader's own highlight-creation
//   endpoint isn't in its public docs; v2's is, and both apps share one
//   highlight store, so a highlight written here shows up in Readwise (and its
//   exports) attached to the same source URL and title.
//
// Rate limits: 20 list calls a minute, 50 writes. A 429 is retried once after
// the Retry-After the server names.
//
// Pure fetch, no react-native imports: the self-check runs this under node
// against a fake server.
import type { Library, Page } from './ports'
import type { LibraryDoc, Location, ReaderDoc, RemoteHighlight } from './types'

export interface ReadwiseOptions {
  readerBase?: string
  readwiseBase?: string
}

const LOCATIONS = new Set<Location>(['new', 'later', 'archive', 'feed'])

export function toLibraryDoc(d: ReaderDoc): LibraryDoc {
  return {
    id: d.id,
    title: d.title?.trim() || 'Untitled',
    author: d.author?.trim() || null,
    category: d.category,
    location: LOCATIONS.has(d.location as Location) ? (d.location as Location) : 'new',
    sourceUrl: d.source_url,
    wordCount: d.word_count,
    summary: d.summary?.trim() || null,
    tags: Array.isArray(d.tags) ? d.tags : d.tags ? Object.keys(d.tags) : [],
    readingProgress: typeof d.reading_progress === 'number' ? d.reading_progress : null,
    publishedDate: d.published_date == null ? null : String(d.published_date),
    updatedAt: d.updated_at,
  }
}

const isHighlight = (d: ReaderDoc) => d.category === 'highlight' && !!d.parent_id
const isNote = (d: ReaderDoc) => d.category === 'note'

export function readwiseLibrary(token: string, opts: ReadwiseOptions = {}): Library {
  const reader = opts.readerBase ?? 'https://readwise.io/api/v3'
  const readwise = opts.readwiseBase ?? 'https://readwise.io/api/v2'
  const headers = { Authorization: `Token ${token}`, 'Content-Type': 'application/json' }

  async function call(url: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
    if (res.status === 429 && !retried) {
      const wait = Math.min(60, Number(res.headers.get('Retry-After')) || 5)
      await new Promise((r) => setTimeout(r, wait * 1000))
      return call(url, init, true)
    }
    if (res.status === 401) throw new Error('Readwise rejected the token — check it at readwise.io/access_token')
    if (res.status === 429) throw new Error('Readwise rate limit hit — wait a minute and retry')
    if (!res.ok) throw new Error(`Readwise ${init.method ?? 'GET'} failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
    return res
  }

  async function list(params: Record<string, string>): Promise<{ results: ReaderDoc[]; nextPageCursor: string | null }> {
    const qs = new URLSearchParams(params).toString()
    return (await call(`${reader}/list/?${qs}`)).json()
  }

  return {
    async listDocuments({ location, updatedAfter, cursor }): Promise<Page<LibraryDoc>> {
      const params: Record<string, string> = { location }
      if (updatedAfter) params.updatedAfter = updatedAfter
      if (cursor) params.pageCursor = cursor
      const { results, nextPageCursor } = await list(params)
      return {
        items: results.filter((d) => !isHighlight(d) && !isNote(d)).map(toLibraryDoc),
        nextCursor: nextPageCursor,
      }
    },

    async fetchHtml(id) {
      const { results } = await list({ id, withHtmlContent: 'true' })
      const d = results[0]
      if (!d) throw new Error('Document not found in Reader')
      return { doc: toLibraryDoc(d), html: d.html_content?.trim() || null }
    },

    async move(id, location) {
      await call(`${reader}/update/${id}/`, { method: 'PATCH', body: JSON.stringify({ location }) })
    },

    async listHighlights({ updatedAfter, cursor }): Promise<Page<RemoteHighlight>> {
      const params: Record<string, string> = { category: 'highlight' }
      if (updatedAfter) params.updatedAfter = updatedAfter
      if (cursor) params.pageCursor = cursor
      const { results, nextPageCursor } = await list(params)
      return {
        items: results.filter(isHighlight).map((d) => ({
          id: d.id,
          docId: d.parent_id as string,
          text: (d.content ?? '').trim(),
          note: d.notes?.trim() || null,
          updatedAt: d.updated_at,
        })),
        nextCursor: nextPageCursor,
      }
    },

    async createHighlight({ doc, text, note }) {
      const res = await call(`${readwise}/highlights/`, {
        method: 'POST',
        body: JSON.stringify({
          highlights: [
            {
              text,
              title: doc.title,
              author: doc.author ?? undefined,
              source_url: doc.sourceUrl ?? undefined,
              source_type: 'reader_out_loud',
              category: doc.category === 'epub' || doc.category === 'pdf' ? 'books' : 'articles',
              note: note || undefined,
              highlighted_at: new Date().toISOString(),
            },
          ],
        }),
      })
      // v2 answers with the books it touched; the new highlight's id is in modified_highlights
      const books = (await res.json()) as { modified_highlights?: (number | string)[] }[]
      const id = books.flatMap((b) => b.modified_highlights ?? [])[0]
      if (id == null) throw new Error('Readwise accepted the highlight but returned no id')
      return { remoteId: String(id) }
    },

    async deleteHighlight(remoteId) {
      await call(`${readwise}/highlights/${remoteId}/`, { method: 'DELETE' })
    },
  }
}
