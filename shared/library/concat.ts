// A highlight is one complete thought: a joke's setup and its punchline, a
// claim and its reason. Usually that is one run of text. When the reader wants
// words skipped in the middle, the thought is saved as several runs that
// Readwise joins back into one highlight: the first gets the note ".c1", the
// next ".c2", and so on (Readwise's concatenation tags). Platform-free.

export interface HighlightPart {
  text: string
  /** The reader's own note, untagged. */
  note?: string
  /** Its place in a concatenated highlight (1, 2...), when words were skipped. */
  concat?: number
}

/** The pieces of a highlight as the tool received it: `parts` when words are skipped, otherwise `text` whole. */
export function highlightParts(input: Record<string, unknown>): string[] {
  const parts = Array.isArray(input.parts)
    ? input.parts.filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter(Boolean)
    : []
  // one run left of several means the skipped words are skipped: keep it, not the whole text
  if (parts.length > 0) return parts
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  return text ? [text] : []
}

/**
 * The highlights to write for one thought. One part is one highlight with the
 * reader's note. Several parts are numbered in order, and the reader's note
 * rides on the first.
 */
export function concatenated(parts: string[], note?: string): HighlightPart[] {
  const clean = note?.trim() || undefined
  if (parts.length <= 1) return parts.map((text) => ({ text, note: clean }))
  return parts.map((text, i) => ({ text, note: i === 0 ? clean : undefined, concat: i + 1 }))
}

/**
 * The note Readwise is sent: the concatenation tag first, then the reader's
 * note. The tag lives only here, so the app never shows ".c2" as a note.
 */
export function readwiseNote(note: string | undefined, concat: number | undefined): string | undefined {
  const tag = concat ? `.c${concat}` : ''
  return [tag, note?.trim()].filter(Boolean).join(' ') || undefined
}

/** How a thought with skipped words reads as one string: the parts joined by an ellipsis. */
export const joinParts = (parts: string[]) => parts.join(' … ')
