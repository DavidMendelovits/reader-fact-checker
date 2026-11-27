// Where to start reading a document the reader just asked for: where they left
// off, the top, a percentage of the way in, or a chapter named by voice
// ("chapter three", "the one about the storm"). Platform-free.
import type { Chapter } from './types'
import { tokens } from './search.ts'

export interface StartAt {
  /** 'resume' (the default) picks up the saved position; 'beginning' is paragraph 0. */
  from?: 'resume' | 'beginning'
  /** 0 to 100: how far into the document. */
  percent?: number
  /** A chapter by number or by words from its title. */
  chapter?: string
}

export type StartResult = { paragraph: number; chapter: string | null } | { error: string }

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
const ROMAN = ['', 'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix', 'xx']
const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth']
const NUMBERED = new Set(['chapter', 'part', 'section', 'book'])
const LABELS = new Set([...NUMBERED, 'the', 'one', 'about', 'where', 'called', 'named', 'last', 'final'])

/**
 * "3", "chapter three", "the third chapter", "three" -> 3. A number word counts
 * only after a label or on its own, so "the one about the storm" is not 1.
 */
function spokenNumber(words: string[]): number | null {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (/^\d+$/.test(w)) return Number(w)
    if (ORDINALS.indexOf(w) > 0) return ORDINALS.indexOf(w)
    const n = NUMBER_WORDS.indexOf(w)
    if (n > 0 && (words.length === 1 || NUMBERED.has(words[i - 1]))) return n
    const r = ROMAN.indexOf(w)
    if (r > 0 && NUMBERED.has(words[i - 1])) return r
  }
  return null
}

/** The chapter a spoken reference means, or null. */
export function findChapter(chapters: Chapter[], spoken: string): number | null {
  const words = tokens(spoken)
  if (words.some((w) => w === 'last' || w === 'final')) return chapters.length - 1
  const n = spokenNumber(words)
  if (n != null) {
    // a title that carries the number wins: "Chapter 3", "III", "Part Three"
    const forms = new Set([String(n), NUMBER_WORDS[n], ROMAN[n]].filter(Boolean))
    // only where a title numbers itself ("Chapter 3", "III. Landfall"), not "What I Saw"
    const titled = chapters.findIndex((c) => tokens(c.title).some((w, j, t) => forms.has(w) && (j === 0 || NUMBERED.has(t[j - 1]))))
    if (titled >= 0) return titled
    if (n >= 1 && n <= chapters.length) return n - 1
  }
  const want = words.filter((w) => !LABELS.has(w) && !/^\d+$/.test(w))
  if (want.length === 0) return null
  let best = -1
  let bestScore = 0
  chapters.forEach((c, i) => {
    const title = tokens(c.title)
    const score = want.filter((w) => title.includes(w) || title.some((t) => t.startsWith(w) && w.length >= 4)).length
    if (score > bestScore) [best, bestScore] = [i, score]
  })
  return best >= 0 ? best : null
}

/**
 * The paragraph to start at. A chapter or a percentage wins over `from`; with
 * neither, 'resume' is the saved position and 'beginning' is the top.
 */
export function startParagraph(chapters: Chapter[], at: StartAt, saved: number | null): StartResult {
  const total = chapters.reduce((n, c) => n + c.paragraphs.length, 0)
  if (total === 0) return { error: 'The document has no text to read.' }
  const starts: number[] = []
  chapters.reduce((n, c) => (starts.push(n), n + c.paragraphs.length), 0)
  const chapterAt = (p: number) => {
    let i = 0
    while (i + 1 < starts.length && starts[i + 1] <= p) i++
    return chapters.length > 1 ? chapters[i].title : null
  }

  if (at.chapter?.trim()) {
    const i = findChapter(chapters, at.chapter)
    if (i == null) {
      const names = chapters.slice(0, 8).map((c) => c.title).join('; ')
      return { error: `No chapter matches "${at.chapter}". The chapters are: ${names}${chapters.length > 8 ? '; ...' : ''}.` }
    }
    return { paragraph: starts[i], chapter: chapters[i].title }
  }
  if (typeof at.percent === 'number' && Number.isFinite(at.percent)) {
    const p = Math.min(total - 1, Math.max(0, Math.floor((total * Math.min(100, Math.max(0, at.percent))) / 100)))
    return { paragraph: p, chapter: chapterAt(p) }
  }
  const p = at.from === 'beginning' || saved == null ? 0 : Math.min(total - 1, Math.max(0, saved))
  return { paragraph: p, chapter: chapterAt(p) }
}

/** open_document's start options off the wire: anything malformed is dropped, not refused. */
export function parseStartAt(input: Record<string, unknown>): StartAt {
  return {
    from: input.from === 'beginning' ? 'beginning' : 'resume',
    percent: typeof input.percent === 'number' && Number.isFinite(input.percent) ? input.percent : undefined,
    chapter: typeof input.chapter === 'string' && input.chapter.trim() ? input.chapter : undefined,
  }
}

/**
 * Where to start a document opened by voice. With no position kept on this
 * device, resuming picks up Reader's own progress, so a book read on the other
 * app or in Reader carries on from there rather than from the top.
 */
export function startFor(chapters: Chapter[], at: StartAt, saved: number | null, readerProgress: number | null | undefined): StartResult {
  const elsewhere = saved == null && at.from !== 'beginning' && at.percent == null && !at.chapter?.trim() && (readerProgress ?? 0) > 0
  return startParagraph(chapters, elsewhere ? { ...at, percent: readerProgress! * 100 } : at, saved)
}

/** What open_document tells the model about where the reader now is. */
export const positionLine = (paragraph: number, chapter: string | null) =>
  `Position: paragraph ${paragraph}${chapter ? ` (chapter "${chapter}")` : ''}. Call read_aloud with no \`from\` to start reading there.`
