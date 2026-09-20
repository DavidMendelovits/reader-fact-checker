// The echo filter, shared by both listeners (web src/lib/voice.ts, phone
// mobile/src/voice.ts). Platform-free on purpose: no DOM, no expo, no React, so
// it runs under `node --experimental-strip-types` and bundles in Metro.
//
// The mic stays live while the document is being read so you can talk over it —
// which is also how the recognizer ends up transcribing the narration itself.

const words = (s: string) => s.toLowerCase().match(/[a-z0-9']+/g) ?? []

/**
 * True when `heard` looks like the recognizer picking up `spoken` out of the
 * speakers rather than the user talking.
 *
 * The comparison slides a window the length of `heard` along `spoken` and scores
 * the best-matching stretch. Scoring against the whole text instead makes the
 * denominator the entire paragraph, and any English sentence overlaps a paragraph
 * of English by more than half on function words alone — so real speech reads as
 * an echo and the barge-in never fires. An actual echo is a transcription of one
 * stretch of audio, so it aligns with one window; incidental vocabulary overlap
 * does not.
 *
 * ponytail: O(spoken × heard) per result, a few hundred × ten a few times a second.
 * Reliable with headphones, mostly right on speakers (Chrome applies its own AEC
 * before we see a transcript). The upgrade is a real AEC path — own the mic via
 * getUserMedia with echoCancellation and feed recognition from that stream.
 */
export function isEcho(heard: string, spoken: string): boolean {
  if (!spoken) return false
  const hw = words(heard)
  if (hw.length === 0) return true
  const sw = words(spoken)
  let best = 0
  for (let i = 0; i < sw.length && best < 1; i++) {
    const window = new Set(sw.slice(i, i + hw.length))
    const overlap = hw.filter((w) => window.has(w)).length / hw.length
    if (overlap > best) best = overlap
  }
  // short utterances share common words by chance, so demand near-total overlap
  return hw.length < 5 ? best === 1 : best > 0.6
}

/**
 * The half-measure isEcho can't express: a final that is part narration and part
 * user ("…at war with one another wait go back"). Dropping the whole line loses
 * the command; passing it whole hands the agent a sentence of the book.
 *
 * Takes the same best-matching window isEcho scores with and subtracts its words
 * from `heard`, returning what is left. Null when fewer than two words survive —
 * one leftover word is as likely to be a stray from the narration as a command.
 *
 * ponytail: set subtraction, so the result is normalized words (lowercased, no
 * punctuation) rather than the user's exact phrasing, and a word the user shares
 * with the narration goes with it. The consumer normalizes anyway; the upgrade is
 * a real alignment (longest common subsequence over positions) if this ever reads
 * wrong out loud.
 */
export function stripEcho(heard: string, spoken: string): string | null {
  const hw = words(heard)
  const sw = words(spoken)
  let best = 0
  let echoed = new Set<string>()
  for (let i = 0; i < sw.length && best < 1; i++) {
    const window = new Set(sw.slice(i, i + hw.length))
    const overlap = hw.filter((w) => window.has(w)).length / hw.length
    if (overlap > best) {
      best = overlap
      echoed = window
    }
  }
  const rest = hw.filter((w) => !echoed.has(w))
  return rest.length >= 2 ? rest.join(' ') : null
}
