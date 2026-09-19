// The fact-check use-case: the verdict prompt and schema, and the parsing that
// makes a degraded verdict out of a surprising answer. The search-grounded model
// behind it is whatever providers().search says.
import type { Source } from './ports.js'
import { providers } from './providers.js'

export interface FactCheckResult {
  verdict: 'accurate' | 'inaccurate' | 'misleading' | 'unverifiable'
  summary: string
  spokenSummary: string
  sources: Source[]
}

const SYSTEM = `You are a fact-checking assistant embedded in an audio ebook reader. The user is listening to a document and asked you to fact check a passage. Search the web to verify the factual claims.

Field guidance (spokenSummary is played to the user the moment it closes, before the rest is finished):
- spokenSummary: 1-2 conversational sentences written to be read aloud by text-to-speech. No URLs, no markdown, no numbers-as-symbols.
- summary: 2-4 sentences on what you found and what it means for the passage.
- Write both fields as plain prose. Never include citation markup, <cite> tags, markdown links, or bracketed reference indices like [1] — every word is fed to a speech synthesizer, and the sources are shown separately in the UI.

Respond with the JSON object and nothing else.

Verdict guide: "accurate" = claims check out; "inaccurate" = a central claim is wrong; "misleading" = technically true but missing critical context; "unverifiable" = could not confirm either way.`

// Enforced by the provider, so the response is always valid JSON.
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['accurate', 'inaccurate', 'misleading', 'unverifiable'] },
    spokenSummary: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['verdict', 'spokenSummary', 'summary'],
  additionalProperties: false,
} as const

const VERDICTS = new Set(['accurate', 'inaccurate', 'misleading', 'unverifiable'])

/**
 * Defensive: strip citation markup that still slips into a field value. Perplexity
 * appends bracketed reference indices to sourced sentences no matter what the prompt
 * says, and TTS reads "[1]" out loud as "bracket one".
 */
const stripCite = (s: string) =>
  s.replace(/<\/?cite[^>]*>/g, '').replace(/\s*\[\d+(?:,\s*\d+)*\]/g, '').trim()

function parseResult(text: string, sources: Source[]): FactCheckResult {
  // response_format pins the shape, but never let a surprise here 500 the request —
  // a degraded verdict beats a broken fact-check.
  const clean = stripCite(text)
  try {
    const parsed = JSON.parse(clean) as Partial<FactCheckResult>
    return {
      verdict: VERDICTS.has(parsed.verdict as string) ? parsed.verdict! : 'unverifiable',
      summary: stripCite(parsed.summary ?? '') || 'The model returned no written summary.',
      spokenSummary: stripCite(parsed.spokenSummary ?? parsed.summary ?? '') || 'I could not produce a verdict for that passage.',
      sources: sources.slice(0, 5),
    }
  } catch {
    return {
      verdict: 'unverifiable',
      summary: clean.slice(0, 600) || 'The model did not return a usable verdict.',
      spokenSummary: 'I could not produce a verdict for that passage.',
      sources: sources.slice(0, 5),
    }
  }
}


/** The prompt for one passage. Every client sends the passage; the wording lives here. */
export const factcheckPrompt = (passage: string) =>
  `Fact check the claims in this passage from the document:\n\n"""${passage}"""`

/**
 * Older clients sent a ready-made chat message instead of the passage. Pull the
 * passage back out of that shape so they keep working until they're updated.
 */
export function passageFromMessages(messages: { role: string; content: string }[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const quoted = last.match(/"""([\s\S]*)"""/)
  return (quoted ? quoted[1] : last).trim()
}

/**
 * Run one fact check. `onDelta` receives the verdict JSON as it is generated, so
 * the client can show — and speak — each field the moment it closes rather than
 * waiting for the object.
 */
export async function factcheck(
  passage: string,
  onDelta: (text: string) => void = () => {},
): Promise<{ result: FactCheckResult }> {
  const { text, sources } = await providers().search.answer(
    { system: SYSTEM, user: factcheckPrompt(passage), schema: VERDICT_SCHEMA },
    onDelta,
  )
  return { result: parseResult(text, sources) }
}

/**
 * Wire format for /api/factcheck, shared by the dev middleware and the Vercel
 * function: newline-delimited JSON, one `delta` per text chunk then one terminal
 * `done` (or `error`). Errors are reported in-band because the status line is long
 * gone by the time the model can fail.
 */
export async function factcheckNdjson(passage: string, write: (line: string) => void): Promise<void> {
  const send = (obj: unknown) => write(`${JSON.stringify(obj)}\n`)
  try {
    const out = await factcheck(passage, (text) => send({ type: 'delta', text }))
    send({ type: 'done', ...out })
  } catch (e) {
    send({ type: 'error', error: e instanceof Error ? e.message : String(e) })
  }
}
