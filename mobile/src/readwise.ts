// Readwise Reader API v3 client — https://readwise.io/reader_api
// List stays light; the HTML rides along only when one document is fetched.
import type { ReaderDoc } from './types'

const BASE = 'https://readwise.io/api/v3'

async function get(token: string, params: Record<string, string>): Promise<{ results: ReaderDoc[]; nextPageCursor: string | null }> {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${BASE}/list/?${qs}`, {
    headers: { Authorization: `Token ${token}` },
  })
  if (res.status === 401) throw new Error('Readwise rejected the token — check it at readwise.io/access_token')
  if (res.status === 429) throw new Error('Readwise rate limit hit — wait a minute and retry')
  if (!res.ok) throw new Error(`Readwise list failed (${res.status})`)
  return res.json()
}

/** First page of the reading list, newest first. Feed items excluded on purpose. */
export async function listDocuments(token: string): Promise<ReaderDoc[]> {
  // Locations are fetched separately because the API takes one at a time.
  // ponytail: first page of each only (~100 docs/location) — pagination when someone hits it.
  const locations = ['new', 'later', 'archive']
  const pages = await Promise.all(locations.map((location) => get(token, { location })))
  return pages
    .flatMap((p) => p.results)
    .filter((d) => d.category !== 'note' && d.category !== 'highlight')
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
}

/** One document with its HTML content. */
export async function fetchDocument(token: string, id: string): Promise<ReaderDoc> {
  const { results } = await get(token, { id, withHtmlContent: 'true' })
  const doc = results[0]
  if (!doc) throw new Error('Document not found in Reader')
  return doc
}
