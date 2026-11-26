// End-to-end self-check on the offline providers. Run it with:
//
//   node --experimental-strip-types --import ./scripts/resolve-ts.mjs api/fakes.check.ts
//
// Every server port is set to `fake` (api/_lib/adapters/fake.ts), so nothing
// leaves the process. Two things are pinned down:
// 1. each route's real code runs on the fakes: agent turn, fact check, claims, TTS
// 2. the tool-call layer end to end: the shared conversation loop, the real
//    agentTurn behind it, and a spoken "is that true?" that starts a background
//    check and keeps reading instead of waiting for the verdict
import assert from 'node:assert/strict'

process.env.AGENT_PROVIDER = 'fake'
process.env.CLAIMS_PROVIDER = 'fake'
process.env.FACTCHECK_PROVIDER = 'fake'
process.env.TTS_PROVIDER = 'fake'
process.env.DECIDER_PROVIDER = 'none'
process.env.FAKE_SEARCH_MS = '0'

const { agentTurn, factcheckNdjson, extractClaims, ttsStream } = await import('./_impl.ts')
const { createAgent } = await import('../shared/voice/agent.ts')
type AgentContext = import('./_impl.ts').AgentContext
type Block = import('../shared/voice/agent.ts').Block

const paragraphs = [
  'The Great Wall of China is visible from the Moon with the naked eye.',
  'It was built over many centuries.',
  'Most of what stands today is from the Ming dynasty.',
]
const context = (at: number): AgentContext => ({
  title: 'Walls',
  totalParagraphs: paragraphs.length,
  currentParagraph: at,
  chapters: [],
  rate: 1,
  nearbyText: paragraphs.map((p, i) => `[${i}] ${p}`).join('\n\n'),
})

// ---- 1. the routes on fakes ----
{
  const opening = await agentTurn([{ role: 'user', content: '[The reader just opened this document and is listening. Take it from here.]' }], context(0))
  assert.deepEqual(opening.content.map((b) => b.type), ['text', 'tool_use'])
  assert.equal((opening.content[1] as { name: string }).name, 'read_aloud')

  const lines: { type: string; result?: { verdict: string; spokenSummary: string } }[] = []
  await factcheckNdjson('The Great Wall is visible from the Moon.', (l) => lines.push(JSON.parse(l)))
  assert.ok(lines.some((l) => l.type === 'delta'), 'the verdict streams')
  const done = lines.at(-1)!
  assert.equal(done.type, 'done')
  assert.equal(done.result?.verdict, 'unverifiable')
  assert.match(done.result!.spokenSummary, /Offline check/)

  assert.deepEqual(await extractClaims('anything'), [])

  const audio = new Uint8Array(await (await ttsStream('Hello there, reader.')).arrayBuffer())
  assert.deepEqual([...audio.slice(0, 2)], [0xff, 0xfb], 'an MP3 frame header')
  assert.ok(audio.length >= 4 * 104, 'at least a few frames of silence')
}

// ---- 2. the tool-call layer: "is that true?" keeps the book going ----
{
  const ranges: number[] = []
  const toolCalls: string[] = []
  let finishRange: ((o: 'completed' | 'stopped') => void) | null = null
  let state = 'idle'
  let checkResolved = false

  const agent = createAgent({
    player: {
      setParagraphs() {},
      setRate() {},
      playFrom(from: number) {
        ranges.push(from)
        return new Promise((r) => { finishRange = r })
      },
      pause() { finishRange?.('stopped') },
      hold() {},
      release() {},
      held: false,
      speak: async () => {},
      currentIndex: 0,
      recentlySpoken: '',
    },
    state: {
      agentState: () => state as never,
      setAgentState: (s) => { state = s },
      playing: () => finishRange !== null,
      paragraphs: () => paragraphs.map((text) => ({ text, chapterIndex: 0 })),
      currentParagraph: () => 0,
      rate: () => 1,
      setRate() {},
      chapters: () => [],
      setInterim() {},
      pushChat() {},
      updateChat() {},
      setNotice: (m) => { throw new Error(`unexpected notice: ${m}`) },
    },
    decide: async () => null,
    // the real server turn, on the fake model
    api: async (messages, ctx) => {
      const out = await agentTurn(messages as never, ctx as AgentContext)
      for (const b of out.content as Block[]) if (b.type === 'tool_use') toolCalls.push(b.name)
      return { content: out.content as Block[] }
    },
    runNav: async () => ({ chat: '', note: '' }),
    tools: {
      // the web's contract: start the check, return at once
      fact_check: () => {
        void Promise.resolve().then(() => { checkResolved = true })
        return 'Started a background fact check.'
      },
    },
    buildContext: () => context(0),
    newId: (() => { let n = 0; return () => `id${++n}` })(),
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  })

  agent.say('wait, is that true?')
  for (let i = 0; i < 50 && ranges.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(toolCalls, ['fact_check', 'read_aloud'], 'checks, then keeps reading in the same turn')
  assert.deepEqual(ranges, [0], 'reading resumed without waiting for a verdict')
  assert.equal(checkResolved, true)
  assert.equal(state, 'reading')
  finishRange!('completed')
}

console.log('fakes end to end: ok')
