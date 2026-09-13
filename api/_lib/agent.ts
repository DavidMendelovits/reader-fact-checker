// The conversational agent: the reading companion's prompt, its tools, and the
// turn use-case. The model behind it is whatever providers().conversation says.
//
// The reading experience is a conversation: the agent drives playback through a
// tool rather than the UI driving the agent. Critically, `read_aloud` takes a
// *range* — playback then runs locally with no model in the loop, and the agent
// only re-enters when the range ends or the user talks over it. Per-paragraph
// tool calls would put a round-trip between every paragraph.
import type { Block, Message, ToolSpec } from './ports.js'
import { providers } from './providers.js'

export interface AgentContext {
  title: string
  totalParagraphs: number
  currentParagraph: number
  chapters: { title: string; startsAt: number }[]
  nearbyText: string
  rate: number
}

export const AGENT_TOOLS: ToolSpec[] = [
  {
    name: 'read_aloud',
    description:
      'Read the document aloud to the user, starting at paragraph `from` and stopping after paragraph `to`. ' +
      'Playback runs locally and does not return until the range finishes or the user interrupts by speaking, ' +
      'so prefer large ranges — a whole chapter or section at a time. Never call this paragraph by paragraph. ' +
      'Omit `from` to continue from the current position. The result reports where playback actually stopped.',
    inputSchema: {
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
    inputSchema: {
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
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words likely to appear in the passage.' } },
      required: ['query'],
    },
  },
  {
    name: 'set_speed',
    description: 'Change playback speed. Takes effect immediately, mid-sentence if need be.',
    inputSchema: {
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
    inputSchema: {
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
// document, so an adapter can cache it (with the tools) — only the per-turn
// context block below is reprocessed.
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
/**
 * One agent turn. `onText` receives the spoken reply as it is generated, so the
 * client can start synthesizing the first sentence while the model is still
 * writing the rest — and, more to the point, while it is still writing the tool
 * call that follows. `onTextEnd` marks the reply's text block closing, because
 * its last sentence has no trailing whitespace to prove it is over and the tool
 * call after it can take seconds to generate.
 */
export async function agentTurn(
  messages: Message[],
  context: AgentContext,
  onText: (text: string) => void = () => {},
  onTextEnd: () => void = () => {},
): Promise<{ content: Block[] }> {
  const model = providers().conversation
  const started = Date.now()
  let firstText = 0
  const result = await model.turn(
    { system: AGENT_SYSTEM_STATIC, context: agentContext(context), tools: AGENT_TOOLS, messages },
    {
      onText: (text) => {
        firstText ||= Date.now()
        onText(text)
      },
      onTextEnd,
    },
  )
  // Latency questions get measured, not guessed. first_text is what the user
  // waits through in silence; turn is what the tool call used to wait behind as
  // well. cache_read > 0 means the static system + tools prefix is being reused.
  const u = result.usage
  console.log(
    `[agent] provider=${model.name} first_text=${firstText ? firstText - started : 0}ms turn=${Date.now() - started}ms` +
      (u ? ` in=${u.input} cache_read=${u.cacheRead} cache_write=${u.cacheWrite} out=${u.output}` : ''),
  )
  return { content: result.content }
}

/**
 * Wire format for /api/agent-stream, shared by the dev middleware and the Vercel
 * function: newline-delimited JSON — a `text` line per reply chunk, `text_end` when
 * a text block closes, then one terminal `done` carrying the full content blocks
 * (or `error`). Errors are reported in-band because the status line is gone
 * before the model can fail. /api/agent keeps the buffered JSON response for
 * clients whose fetch can't read a body incrementally (the mobile app).
 */
export async function agentNdjson(
  messages: Message[],
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
