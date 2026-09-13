// Client for the server-side fact-check endpoints (keys never reach the browser).
// Follow-up questions live in the agent conversation now (lib/agent.ts), so each
// call here is a one-shot verdict.
import type { FactCheckResult } from '../types'
import { apiFetch, apiJson } from './api'

/**
 * The server streams the verdict JSON as it is generated. These pull a field out of
 * a *half-written* object: `partialField` takes whatever is there so far (for the
 * card), `completeField` only matches once the closing quote lands (so we don't
 * speak half a sentence).
 */
const unescape = (s: string) =>
  s.replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\')

export function partialField(raw: string, field: string): string {
  const m = raw.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))
  return m ? unescape(m[1]) : ''
}

export function completeField(raw: string, field: string): string {
  const m = raw.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))
  return m ? unescape(m[1]) : ''
}

// A verdict costs 20-60s and a web search, and the same claim genuinely does come
// round twice — a document scan turns one up, then the reader asks about it aloud.
// Keyed on the promise rather than the result so two checks in flight at once
// collapse into one request too, which a scan does hit.
//
// ponytail: unbounded and per-session. It clears on reload; add an LRU if a long
// sitting ever grows it enough to matter.
const verdicts = new Map<string, Promise<FactCheckResult>>()
const cacheKey = (passage: string) => passage.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Fact check a passage. `onPartial` gets the raw model text so far on every chunk;
 * the resolved value is the parsed result with sources attached.
 *
 * A cached passage resolves immediately and `onPartial` never fires — there is no
 * stream to replay. Callers that speak from the stream must also handle the
 * resolved value, or a cache hit goes silent.
 */
export function checkPassage(
  passage: string,
  onPartial?: (raw: string) => void,
): Promise<FactCheckResult> {
  const key = cacheKey(passage)
  const hit = verdicts.get(key)
  if (hit) return hit
  const pending = runCheck(passage, onPartial)
  pending.catch(() => verdicts.delete(key)) // a failure must not be cached
  verdicts.set(key, pending)
  return pending
}

async function runCheck(
  passage: string,
  onPartial?: (raw: string) => void,
): Promise<FactCheckResult> {
  const res = await apiFetch('/api/factcheck', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passage }), // the prompt around it is the server's business
  })
  if (!res.ok) throw new Error(`/api/factcheck failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  if (!res.body) throw new Error('/api/factcheck returned no body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let raw = ''
  let result: FactCheckResult | null = null

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? '' // trailing partial line
    for (const line of lines) {
      if (!line.trim()) continue
      const msg = JSON.parse(line) as
        | { type: 'delta'; text: string }
        | { type: 'done'; result: FactCheckResult }
        | { type: 'error'; error: string }
      if (msg.type === 'delta') {
        raw += msg.text
        onPartial?.(raw)
      } else if (msg.type === 'done') {
        result = msg.result
      } else {
        throw new Error(msg.error)
      }
    }
  }
  if (!result) throw new Error('The fact check ended without a verdict.')
  return result
}

export async function extractClaims(section: string): Promise<string[]> {
  const { claims } = await apiJson<{ claims: string[] }>('/api/claims', { section })
  return claims
}
