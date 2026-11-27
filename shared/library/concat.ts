// A highlight is one complete thought: a joke's setup and its punchline, a
// claim and its reason. Usually that is one run of text. When the reader wants
// words skipped in the middle, the thought is saved as several runs that
// Readwise joins back into one highlight: the first gets the note ".c1", the
// next ".c2", and so on (Readwise's concatenation tags). Platform-free.

export interface HighlightPart {
  text: string
  note?: string
}

/** The pieces of a highlight as the tool received it: `parts` when words are skipped, otherwise `text` whole. */
export function highlightParts(input: Record<string, unknown>): string[] {
  const parts = Array.isArray(input.parts)
    ? input.parts.map((p) => String(p ?? '').trim()).filter(Boolean)
    : []
  if (parts.length > 1) return parts
  const text = String(input.text ?? parts[0] ?? '').trim()
  return text ? [text] : []
}

/**
 * The highlights to write for one thought. One part is one highlight with the
 * reader's note as is. Several parts each carry their concatenation tag, and
 * the reader's note rides on the first, after its tag.
 */
export function concatenated(parts: string[], note?: string): HighlightPart[] {
  const clean = note?.trim() || undefined
  if (parts.length <= 1) return parts.map((text) => ({ text, note: clean }))
  return parts.map((text, i) => ({ text, note: i === 0 && clean ? `.c1 ${clean}` : `.c${i + 1}` }))
}

/** How a thought with skipped words reads as one string: the parts joined by an ellipsis. */
export const joinParts = (parts: string[]) => parts.join(' … ')
