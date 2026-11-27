// The phone's answers to "what should I read next?" and "what did I highlight
// about naps?", kept out of agent.ts so they test without the phone runtime.
// The picking and the matching are shared with the web (shared/library).
import { joinParts } from '../../shared/library/concat.ts'
import { candidateLine, recommend, type Candidate } from '../../shared/library/recommend.ts'
import { highlightLine, searchHighlights } from '../../shared/library/search.ts'
import type { Highlight, LibraryDoc, RemoteHighlight } from './types'

// ponytail: progress is Reader's. The phone's own place in a book lives in that
// book's saved state, read only when it is opened.
const candidate = (d: LibraryDoc): Candidate => ({ ...d, progress: d.readingProgress })

/** Candidates for what to read next, best first, leaving out the open document. */
export function recommendNext(docs: LibraryDoc[], openId: string | null, input: Record<string, unknown>): string {
  const minutes = typeof input.minutes === 'number' && input.minutes > 0 ? input.minutes : undefined
  const picks = recommend(docs.filter((d) => d.id !== openId).map(candidate), { minutes })
  if (picks.length === 0) return 'Nothing unread to suggest.'
  return picks.map(candidateLine).join('\n')
}

interface OpenDoc {
  title: string
  highlights: Highlight[]
}

/**
 * Highlights across the library: Reader's, plus the open document's that
 * Reader doesn't have yet (made since the last sync, or still on their way).
 * One the reader removed here is left out even before Readwise hears of it.
 *
 * ponytail: a thought with skipped words comes back from Reader as its runs,
 * found one by one; the open document's own are joined into one thought.
 */
export function findHighlights(
  input: Record<string, unknown>,
  lib: { docs: LibraryDoc[]; remoteHighlights: RemoteHighlight[] },
  open: OpenDoc | null,
): string {
  const query = String(input.query ?? '').trim()
  if (!query) return 'No query given.'
  const titles = new Map(lib.docs.map((d) => [d.id, d.title]))
  const mine = open?.highlights ?? []
  const removed = new Set(mine.filter((h) => h.pending === 'delete').map((h) => h.remoteId))
  const remote = lib.remoteHighlights.filter((h) => !removed.has(h.id))
  const inReader = new Set(remote.map((h) => h.id))

  const live = mine.filter((h) => h.pending !== 'delete')
  const runsOf = (h: Highlight) => (h.group ? live.filter((x) => x.group === h.group) : [h])
  const own = live
    .filter((h, i) => !h.group || live.findIndex((x) => x.group === h.group) === i)
    .map(runsOf)
    .filter((runs) => !runs.every((r) => r.remoteId && inReader.has(r.remoteId)))
    .map((runs) => ({ text: joinParts(runs.map((r) => r.text)), note: runs[0].note ?? null, title: open!.title }))

  const all = [...remote.map((h) => ({ text: h.text, note: h.note, title: titles.get(h.docId) ?? 'an unknown document' })), ...own]
  const hits = searchHighlights(all, query)
  if (hits.length === 0) return `No highlight matches "${query}".`
  return hits.map(highlightLine).join('\n')
}
