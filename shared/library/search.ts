// Finding things in the library by voice. Spoken queries are loose ("the
// Hemingway one", "that article about sleep"), so this scores word overlap
// rather than demanding a substring. Platform-free: the phone and the web app
// search the same way.

/** Anything with a title can be searched: a Reader document, a saved web import. */
export interface Searchable {
  title: string
  author?: string | null
  summary?: string | null
  /** ISO time, newest wins a tie. */
  updatedAt?: string
}

const STOP = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'by', 'and', 'or', 'that', 'this', 'one', 'about',
  'book', 'article', 'open', 'read', 'me', 'my', 'please', 'i', 'it', 'is', 'was', 'with', 'for',
])

export const tokens = (s: string): string[] =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9']+/g) ?? []

const terms = (query: string) => tokens(query).filter((t) => !STOP.has(t))

function score(d: Searchable, want: string[]): number {
  const title = tokens(d.title)
  const author = tokens(d.author ?? '')
  const summary = tokens(d.summary ?? '')
  let s = 0
  for (const t of want) {
    if (title.includes(t)) s += 3
    else if (title.some((w) => w.startsWith(t) && t.length >= 4)) s += 2
    if (author.includes(t)) s += 3
    else if (author.some((w) => w.startsWith(t) && t.length >= 3)) s += 2
    if (summary.includes(t)) s += 1
  }
  // every term matched somewhere: a bonus, so "hemingway sea" beats a doc that only has "sea"
  if (want.every((t) => title.includes(t) || author.includes(t) || summary.includes(t))) s += 2
  return s
}

/** The best matches for a spoken query, best first. Empty when nothing matches. */
export function searchDocs<T extends Searchable>(docs: T[], query: string, limit = 6): T[] {
  const want = terms(query)
  if (want.length === 0) return []
  return docs
    .map((d) => ({ d, score: score(d, want) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || ((a.d.updatedAt ?? '') < (b.d.updatedAt ?? '') ? 1 : -1))
    .slice(0, limit)
    .map((x) => x.d)
}

/**
 * Highlights whose text or note shares words with the query, most shared
 * first. A highlight is a passage, not a title, so every matching word counts
 * the same and a phrase match on top wins outright.
 */
export function searchHighlights<T extends { text: string; note?: string | null }>(highlights: T[], query: string, limit = 6): T[] {
  const want = terms(query)
  if (want.length === 0) return []
  const phrase = tokens(query).join(' ')
  return highlights
    .map((h) => {
      const words = new Set([...tokens(h.text), ...tokens(h.note ?? '')])
      const hits = want.filter((t) => words.has(t)).length
      const bonus = phrase.includes(' ') && tokens(h.text).join(' ').includes(phrase) ? want.length : 0
      return { h, score: hits + bonus }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.h)
}
