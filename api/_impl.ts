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

/**
 * One agent turn. `onText` receives the spoken reply as it is generated, so the
 * client can start synthesizing the first sentence while the model is still writing
 * the rest — and, more to the point, while it is still writing the tool call that
 * follows. A "let me check that" used to wait behind the whole fact_check argument
 * being generated before a byte of it went to the synthesizer.
 */
export async function agentTurn(
  messages: Anthropic.MessageParam[],
  context: AgentContext,
  onText: (text: string) => void = () => {},
  onTextEnd: () => void = () => {},
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
  let firstText = 0
  let inText = false
  for await (const event of stream) {
    if (event.type === 'content_block_start') {
      inText = event.content_block.type === 'text'
    } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      firstText ||= Date.now()
      onText(event.delta.text)
    } else if (event.type === 'content_block_stop' && inText) {
      // A reply's last sentence has no trailing whitespace to prove it is over,
      // and the tool call that follows can take seconds to generate. Say so.
      inText = false
      onTextEnd()
    }
  }
  const response = await stream.finalMessage()
  // Same idea as the [factcheck] log: latency questions get measured, not guessed.
  // first_text is what the user waits through in silence; turn is what the tool
  // call used to wait behind as well. cache_read > 0 means the static system +
  // tools prefix is being reused.
  const u = response.usage
  console.log(
    `[agent] first_text=${firstText ? firstText - started : 0}ms turn=${Date.now() - started}ms ` +
      `in=${u.input_tokens} cache_read=${u.cache_read_input_tokens} ` +
      `cache_write=${u.cache_creation_input_tokens} out=${u.output_tokens}`,
  )
  return { content: response.content }
}

/**
 * Wire format for /api/agent-stream, shared by the dev middleware and the Vercel
 * function: newline-delimited JSON — a `text` line per reply chunk, `text_end` when
 * a text block closes, then one terminal `done` carrying the full content blocks
 * (or `error`). Same shape as the
 * fact-check stream, for the same reason: the status line is gone before the model
 * can fail. /api/agent keeps the buffered JSON response for clients whose fetch
 * can't read a body incrementally (the mobile app).
 */
export async function agentNdjson(
  messages: Anthropic.MessageParam[],
  context: AgentContext,
  write: (line: string) => void,
): Promise<void> {
  const send = (obj: unknown) => write(`${JSON.stringify(obj)}\n`)
  try {
    const out = await agentTurn(
      messages,
      context,
      (text) => send({ type: 'text', text }),
      () => send({ type: 'text_end' }),
    )
    send({ type: 'done', ...out })
  } catch (e) {
    send({ type: 'error', error: e instanceof Error ? e.message : String(e) })
  }
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
  return ttsProvider() === 'unreal' ? unrealStream(text) : openaiStream(text)
}

/**
 * Which voice serves /api/tts. Unreal Speech (hosted Kokoro) is roughly a third
 * the price of the alternatives per hour of narration and starts streaming in
 * ~300ms against ~1.2s here; OpenAI stays the fallback so a missing key never
 * takes the voice away. TTS_PROVIDER overrides the guess.
 */
function ttsProvider(): 'unreal' | 'openai' {
  const explicit = process.env.TTS_PROVIDER?.toLowerCase()
  if (explicit === 'unreal' || explicit === 'openai') return explicit
  return process.env.UNREAL_SPEECH_API_KEY ? 'unreal' : 'openai'
}

async function openaiStream(text: string): Promise<Response> {
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

// ---- Unreal Speech ----
//
// Their streaming endpoint takes at most 1,000 characters per call, and a
// paragraph of a book is often longer. The server splits the text at sentence
// boundaries, fetches the pieces in order with one in flight ahead of the one
// being sent, and pipes them back as a single MP3 — so the client's per-paragraph
// player and cache never learn the paragraph was synthesized in pieces.

const UNREAL_BASE = () => process.env.UNREAL_SPEECH_BASE_URL ?? 'https://api.v8.unrealspeech.com'
const UNREAL_MAX_CHARS = 1000
const TTS_MAX_CHARS = 12000 // a runaway paragraph should not become a runaway bill

/**
 * Pack sentences into chunks of at most `max` characters. A sentence that is
 * itself too long is cut at the last whitespace that fits, so nothing is ever
 * split mid-word.
 */
export function chunkForTts(text: string, max = UNREAL_MAX_CHARS): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  // split after sentence-final punctuation followed by a space
  const sentences = clean.split(/(?<=[.!?…]["'”’)\]]*)\s+/)
  const out: string[] = []
  let cur = ''
  const flush = () => {
    if (cur) out.push(cur)
    cur = ''
  }
  for (const s of sentences) {
    if (s.length > max) {
      // oversize sentence: cut at whitespace, as late as possible
      flush()
      let rest = s
      while (rest.length > max) {
        const cut = rest.lastIndexOf(' ', max)
        const at = cut > 0 ? cut : max
        out.push(rest.slice(0, at).trim())
        rest = rest.slice(at).trim()
      }
      cur = rest
      continue
    }
    if (cur && cur.length + 1 + s.length > max) flush()
    cur = cur ? `${cur} ${s}` : s
  }
  flush()
  return out
}

/**
 * Length of an ID3v2 tag at the start of `head`, or 0 if there is none. Every
 * chunk from the vendor arrives as a complete MP3 file with its own tag; the
 * browser's MP3 demuxer only tolerates one, at the very beginning.
 */
export function id3v2Length(head: Uint8Array): number {
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0
  const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f)
  const footer = head[5] & 0x10 ? 10 : 0
  return 10 + size + footer
}

async function unrealFetch(text: string): Promise<Response> {
  const res = await fetch(`${UNREAL_BASE()}/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.UNREAL_SPEECH_API_KEY}`,
    },
    body: JSON.stringify({
      Text: text,
      VoiceId: process.env.UNREAL_SPEECH_VOICE ?? 'Sierra',
      Bitrate: '128k',
    }),
  })
  if (!res.ok) throw new Error(`Unreal Speech failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  if (!res.body) throw new Error('Unreal Speech returned no body')
  return res
}

/**
 * Copy `body` into `out`, dropping a leading ID3v2 tag when `stripTag` is set.
 * The tag header is ten bytes, so buffer until that much has arrived before
 * deciding; the chunks after that pass straight through.
 */
async function pipeMp3(body: ReadableStream<Uint8Array>, out: ReadableStreamDefaultController<Uint8Array>, stripTag: boolean) {
  const reader = body.getReader()
  let pending: Uint8Array | null = stripTag ? new Uint8Array(0) : null
  let skip = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    let buf = value
    if (pending) {
      const joined = new Uint8Array(pending.length + buf.length)
      joined.set(pending)
      joined.set(buf, pending.length)
      if (joined.length < 10) {
        pending = joined
        continue
      }
      skip = id3v2Length(joined)
      pending = null
      buf = joined
    }
    if (skip > 0) {
      const drop = Math.min(skip, buf.length)
      skip -= drop
      buf = buf.subarray(drop)
    }
    if (buf.length > 0) out.enqueue(buf)
  }
  if (pending && pending.length > 0) out.enqueue(pending) // shorter than a tag header: not one
}

async function unrealStream(text: string): Promise<Response> {
  if (!process.env.UNREAL_SPEECH_API_KEY) throw new Error('UNREAL_SPEECH_API_KEY is not set on the server')
  const chunks = chunkForTts(text.slice(0, TTS_MAX_CHARS))
  if (chunks.length === 0) throw new Error('Nothing to say')
  const started = Date.now()

  // The first request is awaited here so a vendor error surfaces as a proper
  // status code; the rest stream behind it, always one fetch ahead of the pipe.
  // A prefetch that fails while the previous chunk is still piping would be an
  // unhandled rejection until the loop reaches it — which Node treats as fatal —
  // so each one gets a no-op handler; the `await` below still sees the error.
  const prefetch = (i: number) => {
    const p = unrealFetch(chunks[i])
    p.catch(() => {})
    return p
  }
  let next = prefetch(0)
  const first = await next
  const stream = new ReadableStream<Uint8Array>({
    async start(out) {
      try {
        for (let i = 0; i < chunks.length; i++) {
          const res = i === 0 ? first : await next
          if (i + 1 < chunks.length) next = prefetch(i + 1)
          await pipeMp3(res.body!, out, i > 0)
        }
        console.log(`[tts] provider=unreal chars=${text.length} chunks=${chunks.length} total=${Date.now() - started}ms`)
        out.close()
      } catch (e) {
        console.error('[tts] unreal stream failed', e)
        out.error(e)
      }
    },
  })
  return new Response(stream, { headers: { 'Content-Type': 'audio/mpeg' } })
}

export async function fetchArticle(url: string): Promise<{ html: string; finalUrl: string }> {
  if (!/^https?:\/\//.test(url)) throw new Error('invalid url')
  const upstream = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (reader-fact-checker POC)' },
    redirect: 'follow',
  })
  return { html: await upstream.text(), finalUrl: upstream.url }
}
