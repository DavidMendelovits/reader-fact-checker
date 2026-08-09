// Server-side implementations shared by the Vite dev middleware and Vercel functions.
// Keys come from process.env — never shipped to the browser.
import Anthropic from '@anthropic-ai/sdk'

export interface FactCheckResult {
  verdict: 'accurate' | 'inaccurate' | 'misleading' | 'unverifiable'
  summary: string
  spokenSummary: string
  sources: { title: string; url: string }[]
}

const MODEL = 'claude-opus-5'
// The conversation loop is latency-sensitive and its turns are simple tool routing;
// Sonnet answers noticeably faster. Fact-checking stays on Opus.
const AGENT_MODEL = 'claude-sonnet-5'
const WEB_SEARCH = { type: 'web_search_20260209' as const, name: 'web_search' as const, max_uses: 5 }

const SYSTEM = `You are a fact-checking assistant embedded in an audio ebook reader. The user is listening to a document and asked you to fact check a passage. Search the web to verify the factual claims.

Field guidance:
- summary: 2-4 sentences on what you found and what it means for the passage.
- spokenSummary: 1-2 conversational sentences written to be read aloud by text-to-speech. No URLs, no markdown, no numbers-as-symbols.
- Write both fields as plain prose. Never include citation markup, <cite> tags, or bracketed reference indices — the sources are shown separately in the UI.

Verdict guide: "accurate" = claims check out; "inaccurate" = a central claim is wrong; "misleading" = technically true but missing critical context; "unverifiable" = could not confirm either way.`

// Enforced server-side by output_config.format, so the response is always valid JSON.
// Previously the model was asked for JSON in prose, and web-search citation markup
// (<cite index="70-4">) leaked into the string values and broke JSON.parse.
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['accurate', 'inaccurate', 'misleading', 'unverifiable'] },
    summary: { type: 'string' },
    spokenSummary: { type: 'string' },
  },
  required: ['verdict', 'summary', 'spokenSummary'],
  additionalProperties: false,
} as const

const VERDICTS = new Set(['accurate', 'inaccurate', 'misleading', 'unverifiable'])

/** Defensive: strip any citation markup that still slips into a field value. */
const stripCite = (s: string) => s.replace(/<\/?cite[^>]*>/g, '').trim()

let _client: Anthropic | null = null
function client(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set on the server')
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  }
  return _client
}

function parseResult(response: Anthropic.Message): FactCheckResult {
  const sources: { title: string; url: string }[] = []
  const seen = new Set<string>()
  let text = ''
  for (const block of response.content) {
    if (block.type === 'text') {
      text += block.text
      for (const c of block.citations ?? []) {
        if ('url' in c && c.url && !seen.has(c.url)) {
          seen.add(c.url)
          sources.push({ title: ('title' in c && c.title) || c.url, url: c.url })
        }
      }
    } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r.type === 'web_search_result' && !seen.has(r.url)) {
          seen.add(r.url)
          sources.push({ title: r.title || r.url, url: r.url })
        }
      }
    }
  }
  // output_config.format guarantees the text is schema-valid JSON, but never let a
  // surprise here 500 the request — a degraded verdict beats a broken fact-check.
  const clean = stripCite(text)
  try {
    const parsed = JSON.parse(clean) as Partial<FactCheckResult>
    const verdict = VERDICTS.has(parsed.verdict as string) ? parsed.verdict! : 'unverifiable'
    return {
      verdict,
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

/**
 * Run one fact-check turn. `messages` is the running conversation (client round-trips it).
 * Returns the verdict plus the updated conversation for follow-ups.
 *
 * `onDelta` receives the model's text as it is generated. Because output_config
 * pins the format, that text is the verdict JSON being built — the client shows
 * the fields as they close rather than staring at an empty card for ~20 seconds.
 */
export async function factcheck(
  messages: Anthropic.MessageParam[],
  onDelta: (text: string) => void = () => {},
): Promise<{
  result: FactCheckResult
  messages: Anthropic.MessageParam[]
}> {
  const stream = client().messages.stream({
    model: MODEL,
    max_tokens: 4096,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
    system: SYSTEM,
    tools: [WEB_SEARCH],
    messages,
  })
  stream.on('text', onDelta)
  const response = await stream.finalMessage()
  return {
    result: parseResult(response),
    messages: [...messages, { role: 'assistant', content: response.content }],
  }
}

/**
 * Wire format for /api/factcheck, shared by the dev middleware and the Vercel
 * function: newline-delimited JSON, one `delta` per text chunk then one terminal
 * `done` (or `error`). Errors are reported in-band because the status line is long
 * gone by the time the model can fail.
 */
export async function factcheckNdjson(
  messages: Anthropic.MessageParam[],
  write: (line: string) => void,
): Promise<void> {
  const send = (obj: unknown) => write(`${JSON.stringify(obj)}\n`)
  try {
    const out = await factcheck(messages, (text) => send({ type: 'delta', text }))
    send({ type: 'done', ...out })
  } catch (e) {
    send({ type: 'error', error: e instanceof Error ? e.message : String(e) })
  }
}

const CLAIMS_SCHEMA = {
  type: 'object',
  properties: { claims: { type: 'array', items: { type: 'string' } } },
  required: ['claims'],
  additionalProperties: false,
} as const

export async function extractClaims(section: string): Promise<string[]> {
  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 2048,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: CLAIMS_SCHEMA } },
    system:
      'Extract the distinct, independently checkable factual claims from the text. Each claim must be self-contained, with enough context to verify on its own. Max 6 claims; pick the most significant or surprising ones. Skip opinions and common knowledge. If nothing is checkable, return an empty list.',
    messages: [{ role: 'user', content: section }],
  })
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  try {
    const parsed = JSON.parse(text) as { claims?: unknown }
    return Array.isArray(parsed.claims) ? parsed.claims.filter((c): c is string => typeof c === 'string') : []
  } catch {
    return [] // a bad section shouldn't abort a whole-document scan
  }
}

// ---- conversational agent ----
//
// The reading experience is a conversation: the agent drives playback through a
// tool rather than the UI driving the agent. Critically, `read_aloud` takes a
// *range* — playback then runs locally with no model in the loop, and the agent
// only re-enters when the range ends or the user talks over it. Per-paragraph
// tool calls would put a round-trip between every paragraph.

export interface AgentContext {
  title: string
  totalParagraphs: number
  currentParagraph: number
  chapters: { title: string; startsAt: number }[]
  nearbyText: string
  rate: number
}

const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_aloud',
    description:
      'Read the document aloud to the user, starting at paragraph `from` and stopping after paragraph `to`. ' +
      'Playback runs locally and does not return until the range finishes or the user interrupts by speaking, ' +
      'so prefer large ranges — a whole chapter or section at a time. Never call this paragraph by paragraph. ' +
      'Omit `from` to continue from the current position. The result reports where playback actually stopped.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'integer', description: 'First paragraph index. Defaults to the current position.' },
        to: { type: 'integer', description: 'Last paragraph index to read. Defaults to the end of the document.' },
      },
    },
  },
  {
    name: 'fact_check',
    description:
      'Verify a factual claim by searching the web. Use this whenever the user questions something in the text, ' +
      'asks whether something is true, or asks about a real-world fact. The full verdict and its sources are ' +
      'displayed on screen as a card, so keep your spoken summary to the gist.',
    input_schema: {
      type: 'object',
      properties: {
        claim: {
          type: 'string',
          description: 'The claim to verify, written to stand alone with enough context to check.',
        },
        anchor: {
          type: 'integer',
          description: 'Paragraph index the claim came from, so the card can link back to it.',
        },
      },
      required: ['claim'],
    },
  },
  {
    name: 'find_in_document',
    description:
      'Search the document text for a phrase or topic and get back matching paragraph indices with ' +
      'snippets. Use this to locate where something is before reading from there — "go to the part ' +
      'where the creature wakes up" — rather than guessing an index.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words likely to appear in the passage.' } },
      required: ['query'],
    },
  },
  {
    name: 'set_speed',
    description: 'Change playback speed. Takes effect immediately, mid-sentence if need be.',
    input_schema: {
      type: 'object',
      properties: { rate: { type: 'number', description: 'Playback rate, 0.5 to 3. Normal is 1.' } },
      required: ['rate'],
    },
  },
  {
    name: 'highlight',
    description:
      'Save a passage to the reader\'s highlights. Use it when the user says "highlight that", ' +
      '"save this passage", or "remember this bit". "That" means the text at or just before the ' +
      'current position — copy the exact wording out of the text shown to you rather than ' +
      'paraphrasing it. When the user attaches a reason or a comment — "highlight that and note: ' +
      'use this in my talk" — put their words in `note`. The highlight is shown on screen, so a ' +
      'short spoken confirmation is enough.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The passage, verbatim — a sentence or two is usually right.' },
        anchor: { type: 'integer', description: 'Paragraph index it came from. Defaults to the current position.' },
        note: {
          type: 'string',
          description:
            'The user\'s own commentary on the passage, in their words — why they wanted it, ' +
            'what they plan to do with it, what it made them think. Omit if they said nothing.',
        },
      },
      required: ['text'],
    },
  },
]

function agentSystem(ctx: AgentContext): string {
  const toc = ctx.chapters
    .slice(0, 60)
    .map((c) => `- ${c.title} (starts at paragraph ${c.startsAt})`)
    .join('\n')

  return `You are a reading companion. The user is listening to a document and talking to you hands-free while it plays.

Everything you write is spoken aloud by a text-to-speech voice. Write short, conversational, plain prose — no markdown, no bullet points, no URLs, no citation markup. Write numbers and years as words. Keep replies to one or two sentences unless the user asks for more.

Document: "${ctx.title}" (${ctx.totalParagraphs} paragraphs)
Current position: paragraph ${ctx.currentParagraph}
Current playback speed: ${ctx.rate}x

Chapters:
${toc || '(single section)'}

Text around the current position:
"""
${ctx.nearbyText}
"""

You are running this book, not narrating on request. The user's hands are busy; voice is the whole interface. Take the lead: start reading rather than asking permission, and when you finish a range, keep going into the next one unless they asked you to stop.

Behaviour:
- When the user wants you to read, call read_aloud with a generous range — a whole chapter is usually right.
- To act on "go back a bit", "skip ahead", "read that again", or "jump to chapter four", just call read_aloud with the right range. There is no separate navigation step.
- Use find_in_document to locate a passage by content before reading from it, rather than guessing at an index.
- When playback comes back interrupted, the user said something. Answer it, then offer to pick up where you left off.
- Vague references like "that", "the last bit", or "what he just said" refer to the text around the current position shown above.
- This document has no page numbers — position is a paragraph index. If the user asks for "page one hundred", don't quibble: scale it against the paragraph count, or pick the nearest chapter start, and just start reading there.
- "Speed up" or "slow down" means about 0.25 off the current speed shown above. Explicit speeds ("one and a half times") are exactly what they say. Stay between 0.5 and 3.
- Use highlight when the user wants a passage saved. "Highlight that" refers to what was just read. If they say why — "note that this is the bit for my talk", "highlight that, it contradicts chapter two" — pass their commentary through as \`note\`, close to how they said it. Don't invent a note they didn't give you.
- When the transcript says the reader is coming back after time away, recap before anything else: one or two sentences on where things stand, nothing past the current position — no spoilers from further in the document — then resume with read_aloud.
- The app answers the simplest commands itself — pause, resume, speed — the instant it hears them, before you see the turn. When the transcript says something was already done, it's done: don't repeat the action, and don't announce it. Say nothing at all if there's nothing left to add.
- Reach for fact_check whenever a claim is worth verifying. Don't guess at facts you could check.
- A fact check takes many seconds. Always say one short line out loud before calling it — "let me check that" — so the user isn't sitting in silence.
- Never paraphrase or summarise the document in place of reading it. read_aloud reads the real text.
- Opening a document is an invitation to begin. Greet them in one short line, say what this is, and start reading — don't wait to be asked.`
}

export async function agentTurn(
  messages: Anthropic.MessageParam[],
  context: AgentContext,
): Promise<{ content: Anthropic.ContentBlock[] }> {
  const stream = client().messages.stream({
    model: AGENT_MODEL,
    max_tokens: 2048,
    system: agentSystem(context),
    tools: AGENT_TOOLS,
    messages,
  })
  const response = await stream.finalMessage()
  return { content: response.content }
}

/**
 * Returns the upstream response so callers can pipe it straight through.
 *
 * Buffering here would cost the whole synthesis time before a byte moves: measured
 * on a typical paragraph, first byte lands at ~1.2s but the full clip takes ~4.9s.
 * Piping means playback starts at first byte, and generation stays far ahead of
 * playback from there (~5s of synthesis for ~30s of speech).
 */
export async function ttsStream(text: string): Promise<Response> {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set on the server')
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'nova', input: text.slice(0, 4000) }),
  })
  if (!res.ok) throw new Error(`TTS failed (${res.status}): ${await res.text()}`)
  if (!res.body) throw new Error('TTS returned no body')
  return res
}

export async function fetchArticle(url: string): Promise<{ html: string; finalUrl: string }> {
  if (!/^https?:\/\//.test(url)) throw new Error('invalid url')
  const upstream = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (reader-fact-checker POC)' },
    redirect: 'follow',
  })
  return { html: await upstream.text(), finalUrl: upstream.url }
}
