// Offline stand-ins for every server port: no keys, no network, no cost.
// `npm run dev:offline` runs the whole app on these, and the checks use them to
// drive the real routes end to end. Each one is deterministic and small; they
// prove the wiring, not the vendor.
//
//   conversation  a rule table that answers like the agent would: greet and
//                 read, check a claim in the background, highlight, answer
//   json          no claims
//   search        a verdict after FAKE_SEARCH_MS (default 4s), streamed in pieces
//   speech        silent MP3, about as long as the text would take to say
import type {
  AudioStream, Block, ConversationModel, JsonCompletion, Message, SearchModel, SpeechSynthesizer, TurnHooks, TurnRequest,
} from '../ports.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let ids = 0
const toolUse = (name: string, input: Record<string, unknown>): Block => ({
  type: 'tool_use', id: `fake_${++ids}`, name, input,
})

/** What the user last said, ignoring tool results: an interruption rides with them. */
function lastUserText(messages: Message[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user')
  if (!last) return ''
  if (typeof last.content === 'string') return last.content
  return last.content
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
}

/** The current paragraph index and its text, read back out of the context block. */
function position(context: string): { at: number; text: string } {
  const at = Number(context.match(/Current position: paragraph (\d+)/)?.[1] ?? 0)
  const text = context.match(new RegExp(`\\[${at}\\] ([^\\n]+)`))?.[1] ?? ''
  return { at, text }
}

function reply(text: string, context: string): Block[] {
  const { at, text: here } = position(context)
  const t = text.toLowerCase()
  const read = () => toolUse('read_aloud', { from: at })
  if (!t.trim()) return [] // tool results only: the fake has nothing to add
  if (t.startsWith('[the reader')) return [{ type: 'text', text: 'Starting where you are.' }, read()]
  if (/\b(true|check|really|accurate|fact)\b/.test(t)) {
    return [
      { type: 'text', text: "I'll check that in the background." },
      toolUse('fact_check', { claim: here || text, anchor: at }),
      read(),
    ]
  }
  if (/\b(highlight|save)\b/.test(t)) return [toolUse('highlight', { text: here, anchor: at }), read()]
  if (/where am i/.test(t)) return [{ type: 'text', text: `You're at paragraph ${at}.` }, read()]
  return [{ type: 'text', text: `You said: ${text.slice(0, 80)}.` }, read()]
}

export function fakeConversation(): ConversationModel {
  return {
    name: 'fake',
    async turn(req: TurnRequest, hooks: TurnHooks = {}) {
      const content = reply(lastUserText(req.messages), req.context)
      for (const b of content) {
        if (b.type !== 'text') continue
        await sleep(30)
        hooks.onText?.(b.text as string)
        hooks.onTextEnd?.()
      }
      return { content, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    },
  }
}

export function fakeJson(): JsonCompletion {
  return { name: 'fake', complete: async () => JSON.stringify({ claims: [] }) }
}

export function fakeSearch(opts: { delayMs?: number } = {}): SearchModel {
  return {
    name: 'fake',
    async answer(req, onDelta = () => {}) {
      const delay = opts.delayMs ?? Number(process.env.FAKE_SEARCH_MS ?? 4000)
      const claim = req.user.match(/"""([\s\S]*)"""/)?.[1] ?? req.user
      const words = claim.trim().split(/\s+/).slice(0, 6).join(' ')
      const text = JSON.stringify({
        verdict: 'unverifiable',
        spokenSummary: `Offline check: nothing was searched for "${words}".`,
        summary: 'This verdict came from the offline fake search provider. No web search ran.',
      })
      // three pieces, so the streaming path is exercised the way a real verdict is
      const step = Math.ceil(text.length / 3)
      for (let i = 0; i < text.length; i += step) {
        await sleep(delay / 3)
        onDelta(text.slice(i, i + step))
      }
      return { text, sources: [{ title: 'Offline fake source', url: 'https://example.com/' }] }
    },
  }
}

/**
 * One silent MPEG-1 Layer III frame: 32 kbps, 44.1 kHz, mono. 104 bytes, 1152
 * samples (about 26 ms). All-zero side info decodes as silence.
 */
const SILENT_FRAME = (() => {
  const f = new Uint8Array(104)
  f.set([0xff, 0xfb, 0x10, 0xc0])
  return f
})()
const FRAME_MS = 1152 / 44.1
const CHARS_PER_SECOND = 15 // about how fast a narrator reads

export function fakeSpeech(): SpeechSynthesizer {
  return {
    name: 'fake',
    mimeType: 'audio/mpeg',
    maxChars: null,
    async synthesize(text: string): Promise<AudioStream> {
      const frames = Math.max(4, Math.round(((text.length / CHARS_PER_SECOND) * 1000) / FRAME_MS))
      const bytes = new Uint8Array(frames * SILENT_FRAME.length)
      for (let i = 0; i < frames; i++) bytes.set(SILENT_FRAME, i * SILENT_FRAME.length)
      return { mimeType: 'audio/mpeg', body: new Blob([bytes]).stream() }
    },
  }
}
