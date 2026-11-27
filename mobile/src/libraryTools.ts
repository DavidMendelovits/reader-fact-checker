// The phone's answers to "what should I read next?" and "what did I highlight
// about naps?", kept out of agent.ts so they test without the phone runtime.
// The picking and the matching are shared with the web (shared/library).
import { joinParts } from '../../shared/library/concat.ts'
import { candidateLine, recommend, type Candidate } from '../../shared/library/recommend.ts'
import { highlightLine, searchHighlights } from '../../shared/library/search.ts'
import type { Highlight, LibraryDoc, RemoteHighlight } from './types'

/**
 * Candidates for what to read next, best first, leaving out the open document.
 * Where the phone has read a document, its own progress beats Reader's.
 */
export function recommendNext(lib: { docs: LibraryDoc[]; progress: Record<string, number> }, openId: string | null, input: Record<string, unknown>): string {
  const minutes = typeof input.minutes === 'number' && input.minutes > 0 ? input.minutes : undefined
  const candidate = (d: LibraryDoc): Candidate => ({ ...d, progress: lib.progress[d.id] ?? d.readingProgress })
  const picks = recommend(lib.docs.filter((d) => d.id !== openId).map(candidate), { minutes })
  if (picks.length === 0) return 'Nothing unread to suggest.'
  return picks.map(candidateLine).join('\n')
}

interface OpenDoc {
  title: string
  highlights: Highlight[]
}

/**
 * Highlights across the library: Reader's (as cached, with the phone's own
 * writes and removals folded in), plus the open document's that Reader doesn't
 * have yet. One removed in the open document is left out even before Readwise
 * hears of it.
 *
 * ponytail: a thought with skipped words comes back from Reader as its runs,
 * found one by one; the open document's own are joined into one thought. A
 * highlight still waiting to reach Readwise from a closed document is not found
 * until it lands, since those sit in each document's saved state.
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
  const inReader = new Set(lib.remoteHighlights.map((h) => h.id))

  const live = mine.filter((h) => h.pending !== 'delete')
  const runsOf = (h: Highlight) => (h.group ? live.filter((x) => x.group === h.group) : [h])
  // a thought Reader doesn't wholly have yet is found as one, here, and its runs that did land are not found again
  const ownThoughts = live
    .filter((h, i) => !h.group || live.findIndex((x) => x.group === h.group) === i)
    .map(runsOf)
    .filter((runs) => !runs.every((r) => r.remoteId && inReader.has(r.remoteId)))
  const hidden = new Set([...mine.filter((h) => h.pending === 'delete'), ...ownThoughts.flat()].map((h) => h.remoteId))
  const remote = lib.remoteHighlights.filter((h) => !hidden.has(h.id))
  const own = ownThoughts.map((runs) => ({ text: joinParts(runs.map((r) => r.text)), note: runs[0].note ?? null, title: open!.title }))

  const all = [...remote.map((h) => ({ text: h.text, note: h.note, title: titles.get(h.docId) ?? 'an unknown document' })), ...own]
  const hits = searchHighlights(all, query)
  if (hits.length === 0) return `No highlight matches "${query}".`
  return hits.map(highlightLine).join('\n')
}
