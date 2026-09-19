// Where a highlight lives in the text. Highlights come from three places — the
// agent ("highlight that"), a long-press, and Reader's own store — and all three
// arrive as *text*, not offsets. Anchoring finds that text in the paragraphs so
// the reader can paint it in place; splitting cuts a paragraph into painted and
// plain runs for rendering.
//
// Pure functions, runs under node for the self-check.

export interface Anchor {
  paragraph: number
  /** Character offsets into the paragraph text. */
  start: number
  end: number
}

// Length-preserving normalization: every replacement is one char for one char,
// so an offset found in the normalized text is the offset in the original.
const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ')

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * Find `text` in `paragraphs`. Tries the hinted paragraph first, then outward
 * from it, then the whole document. A passage that runs past the end of its
 * paragraph (a highlight across two paragraphs) is anchored by its opening and
 * painted to the end of that paragraph.
 */
export function anchorText(paragraphs: string[], text: string, hint?: number): Anchor | null {
  const needle = fold(squash(text))
  if (!needle) return null
  const order = searchOrder(paragraphs.length, hint)
  const tryFind = (n: string): Anchor | null => {
    for (const i of order) {
      const at = fold(paragraphs[i]).indexOf(n)
      if (at >= 0) return { paragraph: i, start: at, end: at + n.length }
    }
    return null
  }
  const whole = tryFind(needle)
  if (whole) return whole
  // opening only: enough of it to be unambiguous, then paint to the paragraph's end
  const opening = needle.slice(0, Math.min(needle.length, Math.max(40, Math.floor(needle.length / 3))))
  if (opening.length < 12) return null
  const head = tryFind(opening)
  return head ? { ...head, end: paragraphs[head.paragraph].length } : null
}

function searchOrder(n: number, hint?: number): number[] {
  if (hint == null || hint < 0 || hint >= n) return Array.from({ length: n }, (_, i) => i)
  const out = [hint]
  for (let d = 1; out.length < n; d++) {
    if (hint - d >= 0) out.push(hint - d)
    if (hint + d < n) out.push(hint + d)
  }
  return out
}

export interface Run<T> {
  text: string
  /** The highlight this run belongs to, or null for plain text. Overlaps go to the earliest. */
  mark: T | null
}

/**
 * Cut one paragraph's text into runs for rendering, given the highlights
 * anchored in it. Ranges are clipped to the text and overlaps resolved in
 * favour of whichever starts first.
 */
export function splitRuns<T extends { start: number; end: number }>(text: string, marks: T[]): Run<T>[] {
  const sorted = [...marks]
    .map((m) => ({ ...m, start: Math.max(0, m.start), end: Math.min(text.length, m.end) }))
    .filter((m) => m.end > m.start)
    .sort((a, b) => a.start - b.start || b.end - a.end)
  const out: Run<T>[] = []
  let pos = 0
  for (const m of sorted) {
    if (m.end <= pos) continue
    const start = Math.max(m.start, pos)
    if (start > pos) out.push({ text: text.slice(pos, start), mark: null })
    out.push({ text: text.slice(start, m.end), mark: m as unknown as T })
    pos = m.end
  }
  if (pos < text.length) out.push({ text: text.slice(pos), mark: null })
  return out.length > 0 ? out : [{ text, mark: null }]
}
