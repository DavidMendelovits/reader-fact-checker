// Reading /api/factcheck's answer. The route speaks NDJSON — a run of `delta`
// lines while the model writes, then one `done` with the result, or an `error`.
// React Native's fetch has no streaming body, so the phone awaits the whole
// thing and reads it here; pulling the reading out of the network call is what
// makes it checkable in plain node.
//
// Pure. No react-native imports.
import type { FactCheckResult } from './types'

/** The line the reader sees when the check came back with nothing to say. */
export const NOTHING_USABLE = 'The fact check returned nothing usable.'

/**
 * Read the body: the first `done` wins, an `error` before it is the answer, and
 * everything else — deltas, blank lines, a half-written line at the end of a cut
 * connection — is skipped.
 */
export function parseFactCheck(text: string): { result: FactCheckResult } | { error: string } {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let parsed: { type?: string; result?: FactCheckResult; error?: string }
    try {
      parsed = JSON.parse(line) as typeof parsed
    } catch {
      continue // a delta that was cut in half, or something that isn't JSON at all
    }
    if (parsed?.type === 'done' && parsed.result) return { result: parsed.result }
    if (parsed?.type === 'error') return { error: parsed.error || NOTHING_USABLE }
  }
  return { error: NOTHING_USABLE }
}
