// Self-check for the shared conversation loop. Run it with:
//
//   node --experimental-strip-types shared/voice/agent.check.ts
//
// Fake everything: a player that records what was asked of it and never really
// speaks, a scripted `api` that hands back the blocks a model would have, and a
// `decide` that is unsure unless a case says otherwise. The bugs this pins down
// are the ones that only show up in the wiring — a hold that never becomes a
// pause, a false start that strands the book, a command run twice because its
// partial and its final both landed, and the fast resume that acknowledged
// "keep going" and then played nothing.
import assert from 'node:assert/strict'
import { createAgent, trim, type Agent, type AgentDeps, type Block, type Msg, type NavResult, type PlayOutcome } from './agent.ts'

type Nav = { kind: string; index?: number }

type Chat = { id: string; role: 'user' | 'assistant'; text: string }

/** A player with a hand crank: playFrom parks until the test resolves it. */
class FakePlayer {
  paragraphs: string[] = []
  rate = 1
  currentIndex = 0
  recentlySpoken = ''
  held = false

  pauseCalls = 0
  holdCalls = 0
  releaseCalls = 0
  spoken: string[] = []
  ranges: { from: number; to: number }[] = []
  outcome: PlayOutcome | null = null

  private settle: ((outcome: PlayOutcome) => void) | null = null

  setParagraphs(paragraphs: string[]) { this.paragraphs = paragraphs }
  setRate(rate: number) { this.rate = rate }

  playFrom(from: number, to: number): Promise<PlayOutcome> {
    this.ranges.push({ from, to })
    this.currentIndex = from
    this.outcome = null
    return new Promise<PlayOutcome>((resolve) => {
      this.settle = (outcome) => { this.outcome = outcome; resolve(outcome) }
    })
  }

  pause() {
    this.pauseCalls++
    this.held = false
    this.settle?.('stopped')
    this.settle = null
  }

  hold() { this.holdCalls++; this.held = true }
  release() { this.releaseCalls++; this.held = false }

  /** The range finished on its own. */
  finish() { this.settle?.('completed'); this.settle = null }

  speak(text: string): Promise<void> { this.spoken.push(text); return Promise.resolve() }
}

type Harness = {
  agent: Agent
  player: FakePlayer
  chat: Chat[]
  interim: string[]
  notices: string[]
  agentStates: string[]
  agentState: () => string
  /** Every `messages` array the transport was handed, in order. */
  sent: Msg[][]
  apiCalls: () => number
}

function harness(opts: {
  script: (call: number, messages: Msg[]) => Block[]
  paragraphs?: number
  currentParagraph?: number
  playing?: boolean
  decide?: (text: string, early: boolean) => Nav | null
  trimAbove?: number
  trimTo?: number
}): Harness {
  const player = new FakePlayer()
  const chat: Chat[] = []
  const interim: string[] = []
  const notices: string[] = []
  const agentStates: string[] = ['idle']
  const sent: Msg[][] = []
  let calls = 0
  let agentState = 'idle'
  let currentParagraph = opts.currentParagraph ?? 0
  let rate = 1
  const total = opts.paragraphs ?? 10
  const paragraphs = Array.from({ length: total }, (_, i) => ({ text: `paragraph ${i}`, chapterIndex: i < total / 2 ? 0 : 1 }))

  const deps: AgentDeps<Nav> = {
    player,
    state: {
      agentState: () => agentState as never,
      setAgentState: (s) => { agentState = s; agentStates.push(s) },
      playing: () => opts.playing ?? false,
      paragraphs: () => paragraphs,
      currentParagraph: () => currentParagraph,
      rate: () => rate,
      setRate: (r) => { rate = r },
      chapters: () => [{ title: 'One' }, { title: 'Two' }],
      setInterim: (text) => { interim.push(text) },
      pushChat: (m) => { chat.push({ ...m }) },
      updateChat: (id, patch) => {
        const m = chat.find((c) => c.id === id)
        if (m) m.text = patch.text
      },
      setNotice: (n) => { notices.push(n) },
    },
    decide: (text, early) => Promise.resolve(opts.decide?.(text, early) ?? null),
    api: (messages) => {
      // snapshot: the loop reassigns `messages` as it trims
      sent.push(messages.map((m) => ({ ...m })))
      return Promise.resolve({ content: opts.script(calls++, messages) })
    },
    runNav: () => Promise.resolve({ chat: '', note: 'platform nav' } as NavResult),
    tools: {},
    buildContext: () => ({}),
    newId: (() => { let n = 0; return () => `id-${++n}` })(),
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    trimAbove: opts.trimAbove,
    trimTo: opts.trimTo,
  }

  return {
    agent: createAgent<Nav>(deps),
    player, chat, interim, notices, agentStates, sent,
    agentState: () => agentState,
    apiCalls: () => calls,
  }
}

const READ_ALOUD: Block[] = [{ type: 'tool_use', id: 'call-1', name: 'read_aloud', input: {} }]
const DONE: Block[] = [{ type: 'text', text: 'All right.' }]

/** Let queued promises and short timers run. */
const settle = async (ms = 20) => { await new Promise((r) => setTimeout(r, ms)) }

/** Every tool_result in a transcript, flattened. */
function toolResults(messages: Msg[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) if (b.type === 'tool_result') out.push(b.content)
  }
  return out
}

// hold -> interim -> pause: the hold becomes the real interruption, which is what
// resolves the parked read_aloud as 'stopped'
{
  const h = harness({ script: (call) => (call === 0 ? READ_ALOUD : DONE) })
  h.agent.openingTurn(() => '[opening]')
  await settle()
  assert.deepEqual(h.player.ranges, [{ from: 0, to: 9 }], 'read_aloud plays the whole document')

  h.agent.beginUtterance()
  assert.equal(h.player.holdCalls, 1, 'beginUtterance holds rather than pausing')
  assert.equal(h.player.pauseCalls, 0)
  assert.equal(h.agentState(), 'listening')

  h.agent.sayInterim('what was that about')
  assert.equal(h.player.pauseCalls, 1, 'the first surviving interim converts the hold into a pause')
  assert.equal(h.player.held, false)
  assert.equal(h.player.outcome, 'stopped', 'playFrom resolves stopped')
  assert.deepEqual(h.interim, ['what was that about'], 'the Composer line shows the words')

  h.agent.say('what was that about')
  await settle(200)
  const results = toolResults(h.sent[h.sent.length - 1])
  assert.ok(
    results.some((r) => r.startsWith('The user interrupted at paragraph 0')),
    `read_aloud reports the interruption, got ${JSON.stringify(results)}`,
  )
}

// hold -> falseStart -> release: a cough costs nothing. No model turn, nothing
// queued, and the state goes back to reading because the player is still in range.
{
  const h = harness({ script: () => DONE, playing: true })
  h.agent.beginUtterance()
  assert.equal(h.player.holdCalls, 1)
  h.agent.falseStart()
  await settle()
  assert.equal(h.player.releaseCalls, 1, 'the hold is released')
  assert.equal(h.player.pauseCalls, 0, 'nothing was interrupted')
  assert.equal(h.apiCalls(), 0, 'no model turn')
  assert.equal(h.agentState(), 'reading', 'still reading: the player never left its range')
  assert.deepEqual(h.interim, [''], 'the interim line is cleared')
  assert.equal(h.chat.length, 0, 'nothing was said, so nothing is shown')
}

// a fast path run off a partial, then its final: one bubble, corrected in place
{
  const h = harness({ script: () => DONE })
  h.agent.sayInterim('stop')
  assert.deepEqual(h.chat.map((c) => [c.role, c.text]), [['user', 'stop'], ['assistant', 'Paused.']])
  const bubble = h.chat[0].id

  h.agent.say('stop reading')
  await settle()
  assert.equal(h.chat.length, 2, 'the final does not post a second bubble')
  assert.equal(h.chat[0].id, bubble)
  assert.equal(h.chat[0].text, 'stop reading', 'the bubble is corrected to what was actually said')
  assert.equal(h.apiCalls(), 0, 'a transport command never reaches the model')
  assert.equal(h.player.pauseCalls, 1, 'and it is not paused twice')
}

// the fast-resume regression (X4): "keep going" with no turn running has to
// actually start the audio, from where the reader is
{
  const h = harness({ script: () => DONE, currentParagraph: 4 })
  h.agent.say('keep going')
  assert.deepEqual(h.player.ranges, [{ from: 4, to: 9 }], 'resumes from the current paragraph')
  assert.equal(h.agentState(), 'reading', 'and says so')
  assert.deepEqual(h.chat.map((c) => c.text), ['keep going', 'Reading.'])
  await settle()
  assert.equal(h.apiCalls(), 0)
}

// an interruption over a running turn: the app did it, so the turn ends with the
// note and the model is not asked anything on top of it
{
  const h = harness({ script: (call) => (call === 0 ? READ_ALOUD : DONE) })
  h.agent.openingTurn(() => '[opening]')
  await settle()
  assert.equal(h.apiCalls(), 1)

  h.agent.say('pause')
  await settle(200)
  assert.equal(h.apiCalls(), 1, 'the turn ends without a second model call')
  assert.equal(h.player.outcome, 'stopped')
  const messages = h.agent.exportMessages()
  const tail = messages[messages.length - 1]
  assert.equal(tail.role, 'assistant')
  assert.equal(tail.content, 'Paused playback.', 'the note is the assistant side of the exchange')
}

// the network dying mid-turn is the line's news, not a toast: the book is on the
// device and reading carries on (Pass 2, Agent turn)
{
  const h = harness({ script: () => { throw new TypeError('Network request failed') } })
  h.agent.openingTurn(() => '[opening]')
  await settle()
  assert.deepEqual(h.chat.map((c) => [c.role, c.text]), [['assistant', 'Offline. Reading still works.']])
  assert.deepEqual(h.notices, [], 'a network failure is never toasted')
}

// a gateway that never reached the model reads the same way to the reader
{
  const h = harness({ script: () => { throw new Error('/api/agent failed (503): upstream') } })
  h.agent.openingTurn(() => '[opening]')
  await settle()
  assert.deepEqual(h.chat.map((c) => c.text), ['Offline. Reading still works.'])
  assert.deepEqual(h.notices, [])
}

// everything else is still a real fault, and still says what it was
{
  const h = harness({ script: () => { throw new Error('/api/agent failed (400): bad request') } })
  h.agent.openingTurn(() => '[opening]')
  await settle()
  assert.deepEqual(h.notices, ['/api/agent failed (400): bad request'])
  assert.deepEqual(h.chat, [], 'and it is not dressed up as a reply')
}

// trim() keeps the head a user message — the API rejects a transcript that starts
// anywhere else, and a slice lands mid-exchange more often than not
{
  const kept = trim(
    [
      { role: 'assistant', content: 'stranded' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'orphan' }] },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
    2,
    3,
  )
  assert.equal(kept[0].role, 'user')
  assert.equal(kept[0].content, 'hello', 'the orphaned tool_result head goes too')
}

// and through the loop: a restored transcript that starts with an assistant turn
// is sendable by the time the transport sees it
{
  const h = harness({ script: () => DONE })
  h.agent.restoreMessages([
    { role: 'assistant', content: 'left over' },
    { role: 'user', content: 'where were we' },
  ])
  h.agent.openingTurn(() => '[opening]')
  await settle()
  assert.equal(h.sent[0][0].role, 'user', 'the transport is never handed an assistant head')
}

console.log('agent.check.ts: ok')
