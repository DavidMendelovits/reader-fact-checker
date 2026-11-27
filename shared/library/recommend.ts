// "What should I read next?" The app doesn't pick; it hands the model a short,
// ordered list of good candidates with enough about each to choose and say why.
// Platform-free.

export interface Candidate {
  id: string
  title: string
  author?: string | null
  summary?: string | null
  wordCount?: number | null
  /** 0..1, how far in the reader is. */
  progress?: number | null
  /** Where it sits: 'new', 'later', 'archive', 'feed', or 'saved' for a web import. */
  location?: string
  /** ISO time. */
  updatedAt?: string
}

export interface RecommendOpts {
  /** How long the reader has. Narration runs about 150 words a minute. */
  minutes?: number
  limit?: number
}

export const WORDS_PER_MINUTE = 150
export const minutesToRead = (words: number) => Math.max(1, Math.round(words / WORDS_PER_MINUTE))

const started = (c: Candidate) => (c.progress ?? 0) >= 0.03 && (c.progress ?? 0) < 0.95

/**
 * Started-but-unfinished first (a reader who left something halfway usually
 * wants it back), then the "later" shelf, then the inbox; newest first within
 * each. With `minutes`, anything that won't fit in about that time (what is
 * left of it, for a started one) drops behind what will. Archived and finished
 * documents are left out.
 */
export function recommend<T extends Candidate>(docs: T[], opts: RecommendOpts = {}): T[] {
  const rank = (c: Candidate) => (started(c) ? 0 : c.location === 'later' || c.location === 'saved' ? 1 : 2)
  const left = (c: Candidate) => (c.wordCount ?? 0) * (1 - (c.progress ?? 0))
  const fits = (c: Candidate) => opts.minutes == null || !c.wordCount || left(c) <= opts.minutes * WORDS_PER_MINUTE * 1.25
  return docs
    .filter((c) => c.location !== 'archive' && c.location !== 'feed' && (c.progress ?? 0) < 0.95)
    .sort(
      (a, b) =>
        Number(fits(b)) - Number(fits(a)) ||
        rank(a) - rank(b) ||
        ((a.updatedAt ?? '') < (b.updatedAt ?? '') ? 1 : -1),
    )
    .slice(0, opts.limit ?? 5)
}

/** One line per candidate, for the model: `[id] Title — Author (12 min, 40% read, later): summary`. */
export function candidateLine(c: Candidate): string {
  const bits: string[] = []
  if (c.wordCount) bits.push(`${minutesToRead(c.wordCount * (1 - (c.progress ?? 0)))} min${started(c) ? ' left' : ''}`)
  if (started(c)) bits.push(`${Math.round((c.progress ?? 0) * 100)}% read`)
  if (c.location) bits.push(c.location === 'new' ? 'inbox' : c.location)
  const summary = c.summary ? `: ${c.summary.length > 160 ? `${c.summary.slice(0, 160)}...` : c.summary}` : ''
  return `[${c.id}] ${c.title}${c.author ? ` by ${c.author}` : ''} (${bits.join(', ')})${summary}`
}
