// Cuts a stream of text into sentences as it arrives, so the first one can go to
// the synthesizer while the model is still writing the rest.
//
// The agent's replies are written for speech — no URLs, no markdown, numbers as
// words — so the boundary rule can stay simple: sentence-final punctuation, then
// whitespace. The abbreviation list is the one guard against cutting a sentence in
// half at "Mr." or "e.g.", which the voice would read as two clipped fragments.

const TERMINAL = /[.!?…]+["'”’)\]]*$/
// A period after one of these is not the end of a sentence.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'etc', 'e.g', 'i.e', 'no', 'vol', 'ch', 'fig',
])

/** True when `head` ends at a sentence boundary that `next` (the text after the whitespace) confirms. */
function isBoundary(head: string): boolean {
  const m = head.match(TERMINAL)
  if (!m) return false
  // the word the punctuation is attached to, without the punctuation
  const word = head
    .slice(0, head.length - m[0].length)
    .match(/[^\s]+$/)?.[0]
    ?.toLowerCase()
  if (!word) return true
  if (m[0].startsWith('.') && ABBREVIATIONS.has(word)) return false
  // a lone initial: "J. R. R. Tolkien"
  if (m[0] === '.' && /^[a-z]$/.test(word)) return false
  return true
}

/**
 * Incremental sentence splitter. `push` returns the sentences completed by the new
 * text; `flush` returns whatever is left when the stream ends.
 */
export class SentenceSplitter {
  private buffer = ''

  push(text: string): string[] {
    this.buffer += text
    const out: string[] = []
    // scan for punctuation followed by whitespace; only whitespace *after* the
    // punctuation proves the sentence is over — the stream may still be mid-word
    let start = 0
    for (let i = 0; i < this.buffer.length; i++) {
      if (!/\s/.test(this.buffer[i])) continue
      const head = this.buffer.slice(start, i)
      if (isBoundary(head)) {
        const s = head.trim()
        if (s) out.push(s)
        start = i + 1
      }
    }
    this.buffer = this.buffer.slice(start)
    return out
  }

  flush(): string | null {
    const s = this.buffer.trim()
    this.buffer = ''
    return s || null
  }
}
