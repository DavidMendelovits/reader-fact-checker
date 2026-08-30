// Server-side implementations shared by the Vite dev middleware and Vercel functions.
// Keys come from process.env — never shipped to the browser.
import Anthropic from '@anthropic-ai/sdk'

export interface FactCheckResult {
  verdict: 'accurate' | 'inaccurate' | 'misleading' | 'unverifiable'
  summary: string
  spokenSummary: string
  sources: { title: string; url: string }[]
}

// Fact checks run on Perplexity: search *is* the product there, so the retrieval
// happens inside one inference pass instead of an agentic search-then-read loop.
// Claim extraction and the conversation loop stay on Sonnet — neither needs the web.
const PPLX_MODEL = 'sonar' // fact check
const MODEL = 'claude-sonnet-5' // claim extraction
const AGENT_MODEL = 'claude-sonnet-5' // conversation loop

const SYSTEM = `You are a fact-checking assistant embedded in an audio ebook reader. The user is listening to a document and asked you to fact check a passage. Search the web to verify the factual claims.

Field guidance (spokenSummary is played to the user the moment it closes, before the rest is finished):
- spokenSummary: 1-2 conversational sentences written to be read aloud by text-to-speech. No URLs, no markdown, no numbers-as-symbols.
- summary: 2-4 sentences on what you found and what it means for the passage.
- Write both fields as plain prose. Never include citation markup, <cite> tags, markdown links, or bracketed reference indices like [1] — every word is fed to a speech synthesizer, and the sources are shown separately in the UI.

Respond with the JSON object and nothing else.

Verdict guide: "accurate" = claims check out; "inaccurate" = a central claim is wrong; "misleading" = technically true but missing critical context; "unverifiable" = could not confirm either way.`

// Enforced server-side by response_format, so the response is always valid JSON.
// Previously the model was asked for JSON in prose, and search citation markup
// leaked into the string values and broke JSON.parse.
//
// Note for anyone tuning the streamed-verdict path: Perplexity does NOT emit these
// in declaration order the way Anthropic's constrained decoding did — measured, it
// sorts the properties alphabetically (spokenSummary, summary, verdict). That
// happens to put the spoken line first, which is what we wanted anyway, but it is
// luck rather than something this declaration controls. Don't reorder for effect;
// rename a field and the wire order moves.
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

let _client: Anthropic | null = null
function client(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set on the server')
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  }
  return _client
}

type Source = { title: string; url: string }

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

/**
 * Perplexity streams SSE: `data: {json}` per chunk, terminated by `data: [DONE]`.
 * Content arrives as OpenAI-style deltas; sources ride along on the chunks as
 * `search_results` (objects) or, on older responses, `citations` (bare URLs).
 */
function readChunk(
  json: string,
  sources: Source[],
  seen: Set<string>,
): string {
  const chunk = JSON.parse(json) as {
    choices?: { delta?: { content?: string }; message?: { content?: string } }[]
    search_results?: { title?: string; url?: string }[]
    citations?: string[]
  }
  for (const r of chunk.search_results ?? []) {
    if (r.url && !seen.has(r.url)) {
      seen.add(r.url)
      sources.push({ title: r.title || r.url, url: r.url })
    }
  }
  for (const url of chunk.citations ?? []) {
    if (url && !seen.has(url)) {
      seen.add(url)
      sources.push({ title: url, url })
    }
  }
  return chunk.choices?.[0]?.delta?.content ?? ''
}

/**
 * Run one fact-check turn against Perplexity. `messages` is the running conversation
 * (the client round-trips it); the OpenAI-shaped {role, content} it sends is what
 * Perplexity takes, so no translation is needed.
 *
 * `onDelta` receives the verdict JSON as it is generated, so the client can show —
 * and speak — each field the moment it closes rather than waiting for the object.
 */
export async function factcheck(
  messages: { role: string; content: string }[],
  onDelta: (text: string) => void = () => {},
): Promise<{ result: FactCheckResult }> {
  if (!process.env.PERPLEXITY_API_KEY) throw new Error('PERPLEXITY_API_KEY is not set on the server')
  const started = Date.now()
  let firstText = 0

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
    },
    body: JSON.stringify({
      model: PPLX_MODEL,
      stream: true,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
      response_format: { type: 'json_schema', json_schema: { schema: VERDICT_SCHEMA } },
    }),
  })
  if (!res.ok) throw new Error(`Perplexity failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  if (!res.body) throw new Error('Perplexity returned no body')

  const sources: Source[] = []
  const seen = new Set<string>()
  let text = ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // SSE events are blank-line separated; keep the trailing partial for next read
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const event of events) {
      const json = event
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('')
      if (!json || json === '[DONE]') continue
      let delta = ''
      try {
        delta = readChunk(json, sources, seen)
      } catch {
        continue // a malformed chunk is not worth failing the whole verdict over
      }
      if (!delta) continue
      firstText ||= Date.now()
      text += delta
      onDelta(delta)
    }
  }

  // Perplexity searches before it writes a byte, so time-to-first-text is the
  // retrieval phase and the rest is generation. That split is the whole question
  // behind picking `sonar` vs `sonar-pro` — log it rather than guess. Shows up in
  // `vercel logs` and the dev server's terminal.
  console.log(
    `[factcheck] search=${(firstText || Date.now()) - started}ms write=${firstText ? Date.now() - firstText : 0}ms ` +
      `total=${Date.now() - started}ms sources=${sources.length} model=${PPLX_MODEL}`,
  )

  return { result: parseResult(text, sources) }
}

/**
 * Wire format for /api/factcheck, shared by the dev middleware and the Vercel
 * function: newline-delimited JSON, one `delta` per text chunk then one terminal
 * `done` (or `error`). Errors are reported in-band because the status line is long
 * gone by the time the model can fail.
 */
export async function factcheckNdjson(
  messages: { role: string; content: string }[],
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

// Static half of the system prompt. Byte-stable across every turn and every
// document, so it caches (with the tools) behind the cache_control breakpoint —
// only the per-turn context block below is reprocessed.
const AGENT_SYSTEM_STATIC = `You are a reading companion. The user is listening to a document and talking to you hands-free while it plays.

Everything you write is spoken aloud by a text-to-speech voice. Write short, conversational, plain prose — no markdown, no bullet points, no URLs, no citation markup. Write numbers and years as words. Keep replies to one or two sentences unless the user asks for more.

You are running this book, not narrating on request. The user's hands are busy; voice is the whole interface. Take the lead: start reading rather than asking permission, and when you finish a range, keep going into the next one unless they asked you to stop.

Never reply with a filler acknowledgment — no "what's up", "go ahead", "sure thing", "I'm listening". If the user asked for something, do it: call the tool in the same turn, saying nothing unless there is something real to say. Silence into action always beats a spoken placeholder.

Behaviour:
- When the user wants you to read or continue, call read_aloud immediately with no spoken preamble — a generous range, a whole chapter is usually right.
- To act on "go back a bit", "skip ahead", "read that again", or "jump to chapter four", just call read_aloud with the right range. There is no separate navigation step.
- Use find_in_document to locate a passage by content before reading from it, rather than guessing at an index.
- When playback comes back interrupted, the user said something. Answer it, then resume reading with read_aloud yourself — don't ask whether to continue.
- Vague references like "that", "the last bit", or "what he just said" refer to the text around the current position shown below.
- This document has no page numbers — position is a paragraph index. If the user asks for "page one hundred", don't quibble: scale it against the paragraph count, or pick the nearest chapter start, and just start reading there.
- "Speed up" or "slow down" means about 0.25 off the current speed shown below. Explicit speeds ("one and a half times") are exactly what they say. Stay between 0.5 and 3.
- Use highlight when the user wants a passage saved. "Highlight that" refers to what was just read. If they say why — "note that this is the bit for my talk", "highlight that, it contradicts chapter two" — pass their commentary through as \`note\`, close to how they said it. Don't invent a note they didn't give you.
- When the transcript says the reader is coming back after time away, recap before anything else: one or two sentences on where things stand, nothing past the current position — no spoilers from further in the document — then resume with read_aloud.
- The app answers the simplest commands itself — pause, resume, speed — the instant it hears them, before you see the turn. When the transcript says something was already done, it's done: don't repeat the action, and don't announce it. Say nothing at all if there's nothing left to add.
- Reach for fact_check whenever a claim is worth verifying. Don't guess at facts you could check.
- A fact check takes many seconds. Always say one short line out loud before calling it — "let me check that" — so the user isn't sitting in silence.
- Never paraphrase or summarise the document in place of reading it. read_aloud reads the real text.
- Opening a document is an invitation to begin. Greet them in one short line, say what this is, and start reading in the same turn — don't wait to be asked.`

function agentContext(ctx: AgentContext): string {
  const toc = ctx.chapters
    .slice(0, 60)
    .map((c) => `- ${c.title} (starts at paragraph ${c.startsAt})`)
    .join('\n')

  return `Document: "${ctx.title}" (${ctx.totalParagraphs} paragraphs)
Current position: paragraph ${ctx.currentParagraph}
Current playback speed: ${ctx.rate}x

Chapters:
${toc || '(single section)'}

Text around the current position:
"""
${ctx.nearbyText}
"""`
}

export async function agentTurn(
  messages: Anthropic.MessageParam[],
  context: AgentContext,
): Promise<{ content: Anthropic.ContentBlock[] }> {
  const stream = client().messages.stream({
    model: AGENT_MODEL,
    max_tokens: 2048,
    // Low effort: a voice companion's turns are one line and a tool call.
    // Sonnet 5 defaults to high, which spends seconds thinking before the
    // first spoken word.
    output_config: { effort: 'low' },
    system: [
      { type: 'text', text: AGENT_SYSTEM_STATIC, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: agentContext(context) },
    ],
    tools: AGENT_TOOLS,
    messages,
  })
  const started = Date.now()
  const response = await stream.finalMessage()
  // Same idea as the [factcheck] log: latency questions get measured, not guessed.
  // cache_read > 0 means the static system + tools prefix is being reused.
  const u = response.usage
  console.log(
    `[agent] turn=${Date.now() - started}ms in=${u.input_tokens} cache_read=${u.cache_read_input_tokens} ` +
      `cache_write=${u.cache_creation_input_tokens} out=${u.output_tokens}`,
  )
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

/**
 * /api/fetch is an unauthenticated proxy that fetches whatever URL it's handed —
 * without this it reaches localhost, the private ranges, and cloud metadata from
 * inside the deployment. Hostname-level checks; a DNS-rebinding-proof version
 * needs to resolve and pin the address, which a POC article reader doesn't earn.
 */
export function blockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  const v4 = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT — where some cloud metadata services live
      (a === 169 && b === 254) || // link-local, 169.254.169.254 metadata included
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  // URL#hostname strips the brackets off an IPv6 literal
  return h === '::' || h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')
}

const MAX_ARTICLE_BYTES = 5_000_000

export async function fetchArticle(url: string): Promise<{ html: string; finalUrl: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('invalid url')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid url')
  if (blockedHost(parsed.hostname)) throw new Error('that host is not fetchable')
  const upstream = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (reader-fact-checker POC)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000), // a hung origin must not hold the function open
  })
  // redirects can land somewhere the original hostname check never saw
  if (blockedHost(new URL(upstream.url).hostname)) throw new Error('that host is not fetchable')
  const length = Number(upstream.headers.get('content-length'))
  if (length > MAX_ARTICLE_BYTES) throw new Error('page too large to import')
  const html = await upstream.text()
  if (html.length > MAX_ARTICLE_BYTES) throw new Error('page too large to import')
  return { html, finalUrl: upstream.url }
}
