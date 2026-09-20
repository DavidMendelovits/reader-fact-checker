// Self-check for the shared loop's edges: what happens when a tool throws, when
// the model asks for a tool nobody declared, when the speech service is gone,
// when the model loops on tools, when the network dies in each of its dialects,
// when a persisted transcript comes back broken, and what the shared navigation
// kinds do at the ends of the book. Run it with:
//
//   node --experimental-strip-types shared/voice/agent.errors.check.ts
//
// agent.check.ts owns the happy wiring (hold → pause, false start, fast resume).
// Everything here is the error handler or the boundary condition beside it.
import assert from 'node:assert/strict'
import { createAgent, repair, type Agent, type AgentDeps, type Block, type Msg, type NavResult, type PlayOutcome } from './agent.ts'

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
  pause() { this.pauseCalls++; this.held = false; this.settle?.('stopped'); this.settle = null }
  hold() { this.held = true }
  release() { this.held = false }
  finish() { this.settle?.('completed'); this.settle = null }
  /** The speech service is unreachable: the web player's third strike. */
  fail() { this.settle?.('failed'); this.settle = null }
  speak(text: string): Promise<void> { this.spoken.push(text); return Promise.resolve() }
}

type Harness = {
  agent: Agent
  player: FakePlayer
  chat: Chat[]
  notices: string[]
  agentState: () => string
  rate: () => number
  sent: Msg[][]
  apiCalls: () => number
}

function harness(opts: {
  script: (call: number, messages: Msg[]) => Block[]
  paragraphs?: number
  currentParagraph?: number
  decide?: (text: string, early: boolean) => Nav | null
  tools?: AgentDeps<Nav>['tools']
}): Harness {
  const player = new FakePlayer()
  const chat: Chat[] = []
  const notices: string[] = []
  const sent: Msg[][] = []
  let calls = 0
  let agentState = 'idle'
  let rate = 1
  const currentParagraph = opts.currentParagraph ?? 0
  const total = opts.paragraphs ?? 10
  // two chapters of five: 0..4 are "One", 5..9 are "Two"
  const paragraphs = Array.from({ length: total }, (_, i) => ({ text: `paragraph ${i}`, chapterIndex: i < total / 2 ? 0 : 1 }))

  const deps: AgentDeps<Nav> = {
    player,
    state: {
      agentState: () => agentState as never,
      setAgentState: (s) => { agentState = s },
      playing: () => false,
      paragraphs: () => paragraphs,
      currentParagraph: () => currentParagraph,
      rate: () => rate,
      setRate: (r) => { rate = r },
      chapters: () => (total > 0 ? [{ title: 'One' }, { title: 'Two' }] : []),
      setInterim: () => {},
      pushChat: (m) => { chat.push({ ...m }) },
      updateChat: (id, patch) => { const m = chat.find((c) => c.id === id); if (m) m.text = patch.text },
      setNotice: (n) => { notices.push(n) },
    },
    decide: (text, early) => Promise.resolve(opts.decide?.(text, early) ?? null),
    api: (messages) => {
      sent.push(messages.map((m) => ({ ...m })))
      return Promise.resolve({ content: opts.script(calls++, messages) })
    },
    runNav: () => Promise.resolve({ chat: '', note: 'platform nav' } as NavResult),
    tools: opts.tools ?? {},
    buildContext: () => ({}),
    newId: (() => { let n = 0; return () => `id-${++n}` })(),
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }

  return {
    agent: createAgent<Nav>(deps),
    player, chat, notices, sent,
    agentState: () => agentState,
    rate: () => rate,
    apiCalls: () => calls,
  }
}

const READ_ALOUD: Block[] = [{ type: 'tool_use', id: 'call-1', name: 'read_aloud', input: {} }]
const DONE: Block[] = [{ type: 'text', text: 'All right.' }]
const call = (name: string, input: Record<string, unknown> = {}, id = 'call-x'): Block[] => [{ type: 'tool_use', id, name, input }]

const settle = async (ms = 20) => { await new Promise((r) => setTimeout(r, ms)) }

function toolResults(messages: Msg[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) if (b.type === 'tool_result') out.push(b.content)
  }
  return out
}

// ---- repair(): the transcript is made sendable, not rewritten ----

// an orphaned tool_use followed by a plain user string (a fast-path append after a
// reload mid-read_aloud) gets its synthetic result in front of the words
{
  const msgs: Msg[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read_aloud', input: {} }] },
    { role: 'user', content: 'again' },
  ]
  const out = repair(msgs)
  assert.equal(out.length, 3, 'no message is added when the next user turn can carry the result')
  assert.equal(msgs.length, 3, 'the input array is not spliced')
  const third = out[2].content as Block[]
  assert.equal(third[0].type, 'tool_result')
  assert.equal((third[0] as { tool_use_id: string }).tool_use_id, 'c1')
  assert.match((third[0] as { content: string }).content, /Interrupted/)
  assert.deepEqual(third[1], { type: 'text', text: 'again' }, 'the words follow the result, so roles still alternate')
}

// a trailing tool_use gets a user turn of its own, and an answered call is left alone
{
  const trailing: Msg[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c2', name: 'read_aloud', input: {} }] },
  ]
  const out = repair(trailing)
  assert.equal(out.length, 3)
  assert.equal(trailing.length, 2, 'the input array is not appended to')
  assert.equal(out[2].role, 'user')
  assert.deepEqual(
    (out[2].content as Block[]).map((b) => b.type === 'tool_result' && b.tool_use_id),
    ['c2'],
  )

  const answered: Msg[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c3', name: 'set_speed', input: { rate: 2 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c3', content: 'ok' }] },
  ]
  assert.deepEqual(repair(answered), answered, 'a complete exchange is untouched')
}

// ---- the tool runner's error handlers ----

// a tool that throws is a result for the model, not the end of the turn; a tool
// nobody declared says so. Both keep the loop going to the next model call.
{
  const h = harness({
    script: (n) => (n === 0
      ? [
          { type: 'tool_use', id: 't1', name: 'highlight', input: {} },
          { type: 'tool_use', id: 't2', name: 'make_coffee', input: {} },
        ]
      : DONE),
    tools: { highlight: () => { throw new Error('not signed in') } },
  })
  h.agent.openingTurn(() => '[opening]')
  await settle(50)
  assert.equal(h.apiCalls(), 2, 'the loop carries on to a second model call')
  assert.deepEqual(toolResults(h.sent[1]), ['The tool failed: not signed in', 'Unknown tool: make_coffee'])
  assert.deepEqual(h.notices, [], 'a tool failure is never a toast')
  assert.equal(h.agentState(), 'idle')
  assert.deepEqual(h.chat.map((c) => c.text), ['All right.'], 'and the reply after it is still spoken')
}

// read_aloud with nothing open is a plain answer, and the player is never touched
{
  const h = harness({ script: (n) => (n === 0 ? READ_ALOUD : DONE), paragraphs: 0 })
  h.agent.openingTurn(() => '[opening]')
  await settle(50)
  assert.deepEqual(toolResults(h.sent[1]), ['No document is loaded.'])
  assert.deepEqual(h.player.ranges, [], 'no range is started on an empty document')
  assert.equal(h.apiCalls(), 2)
}

// the speech service dying mid-range is both a toast and a result that tells
// the model not to try again this turn
{
  const h = harness({ script: (n) => (n === 0 ? READ_ALOUD : DONE) })
  h.agent.openingTurn(() => '[opening]')
  await settle()
  assert.deepEqual(h.player.ranges, [{ from: 0, to: 9 }])
  h.player.fail()
  await settle(50)
  assert.equal(h.notices.length, 1)
  assert.match(h.notices[0], /^Narration failed/)
  const [result] = toolResults(h.sent[1])
  assert.match(result, /^Narration failed/)
  assert.match(result, /Do not retry read_aloud this turn/)
  assert.equal(h.agentState(), 'idle', 'the state leaves reading the moment playFrom resolves')
}

// a model that never stops asking for tools is cut off at MAX_TURNS (12) and the
// agent comes back to rest
{
  const h = harness({ script: (n) => call('noop', {}, `c${n}`) })
  h.agent.openingTurn(() => '[opening]')
  await settle(200)
  assert.equal(h.apiCalls(), 12, 'twelve turns, then the backstop')
  assert.equal(h.agentState(), 'idle')
  assert.deepEqual(h.notices, [], 'the backstop is silent')
  // and the next utterance still gets a loop of its own: `running` was reset
  h.agent.say('are you there')
  await settle(200)
  assert.equal(h.apiCalls(), 24, 'a second full loop, not a stuck agent')
}

// ---- speed: the fast paths and the clamp ----
{
  const h = harness({
    script: (n) => (n === 0 ? call('set_speed', { rate: 0.1 }, 's1') : n === 1 ? call('set_speed', { rate: 'fast' }, 's2') : DONE),
  })
  const speeds: number[] = []
  for (const said of ['faster', 'slower', 'two x', '1.5x', 'go 9 x', 'half speed']) {
    h.agent.say(said)
    speeds.push(h.rate())
  }
  assert.deepEqual(speeds, [1.25, 1, 2, 1.5, 3, 0.5], 'faster/slower step by 0.25; "go 9 x" clamps to 3')
  assert.equal(h.player.rate, 0.5, 'the player follows the store')
  assert.deepEqual(h.chat.filter((c) => c.role === 'assistant').map((c) => c.text), ['1.25x.', '1x.', '2x.', '1.5x.', '3x.', '0.5x.'])
  await settle()
  assert.equal(h.apiCalls(), 0, 'none of it went to the model')

  // the tool: a rate below the floor clamps up, a rate that is not a number is 1x
  h.agent.openingTurn(() => '[opening]')
  await settle(50)
  assert.deepEqual(toolResults(h.sent[2]), ['Playback speed is now 0.5x.', 'Playback speed is now 1x.'])
  assert.equal(h.rate(), 1)
}

// ---- isOffline(): every dialect of "the network is gone" is the line's news ----
{
  const dialects: [string, () => never][] = [
    ['a 502 in the adapter message', () => { throw new Error('/api/agent failed (502): bad gateway') }],
    ['a status of 0 on a non-Error', () => { throw { status: 0 } }],
    ["Safari's 'Load failed'", () => { throw new Error('Load failed') }],
  ]
  for (const [name, die] of dialects) {
    const h = harness({ script: () => die() })
    h.agent.openingTurn(() => '[opening]')
    await settle()
    assert.deepEqual(h.chat.map((c) => c.text), ['Offline. Reading still works.'], name)
    assert.deepEqual(h.notices, [], `${name}: never toasted`)
    assert.equal(h.player.pauseCalls, 1, `${name}: a failed turn pauses whatever was playing`)
    assert.equal(h.agentState(), 'idle')
  }
}

// ---- restoreMessages(): whatever persistence hands back, the transport gets a valid head ----
{
  const h = harness({ script: () => DONE })
  h.agent.restoreMessages(null as unknown as unknown[])
  assert.deepEqual(h.agent.exportMessages(), [], 'null restores to nothing')
  h.agent.restoreMessages(undefined as unknown as unknown[])
  assert.deepEqual(h.agent.exportMessages(), [])

  h.agent.restoreMessages([{}, { role: 'assistant', content: 'stale' }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'x' }] }])
  h.agent.openingTurn(() => '[opening]')
  await settle(50)
  assert.deepEqual(h.sent[0], [{ role: 'user', content: '[opening]' }], 'junk heads are dropped before anything is sent')
  assert.deepEqual(h.notices, [])
}

// ---- the shared navigation kinds ----

// a chapter jump: the title is said once, the range starts at the chapter, and
// the model is told afterwards without a turn of its own
{
  const h = harness({ script: () => DONE, decide: (t) => (t === 'go to chapter two' ? { kind: 'chapter', index: 1 } : null) })
  h.agent.say('go to chapter two')
  await settle(50)
  assert.deepEqual(h.player.spoken, ['Two.'])
  assert.deepEqual(h.player.ranges, [{ from: 5, to: 9 }], 'reads from the first paragraph of chapter two')
  assert.deepEqual(h.chat.map((c) => [c.role, c.text]), [['user', 'go to chapter two'], ['assistant', 'Two.']], 'one bubble, not two')
  assert.equal(h.apiCalls(), 0)
  const messages = h.agent.exportMessages()
  assert.equal(messages[messages.length - 1].content, 'Jumped to "Two" and started reading there.')
  assert.equal(h.agentState(), 'reading')
}

// the ends of the book: next past the last chapter and previous before the first
// are said, not played; and "back a chapter" from deep inside one restarts it
{
  const atLast = harness({ script: () => DONE, currentParagraph: 7, decide: () => ({ kind: 'next_chapter' }) })
  atLast.agent.say('next chapter')
  await settle(50)
  assert.deepEqual(atLast.player.ranges, [], 'nothing to play past the end')
  assert.deepEqual(atLast.player.spoken, ['That was the last chapter.'], 'said aloud, since it was not spoken by a jump')
  assert.equal(atLast.agent.exportMessages()[1].content, 'That was the last chapter.')

  const atFirst = harness({ script: () => DONE, currentParagraph: 0, decide: () => ({ kind: 'previous_chapter' }) })
  atFirst.agent.say('previous chapter')
  await settle(50)
  assert.deepEqual(atFirst.player.ranges, [])
  assert.deepEqual(atFirst.player.spoken, ['This is the first chapter.'])

  const deepInside = harness({ script: () => DONE, currentParagraph: 9, decide: () => ({ kind: 'previous_chapter' }) })
  deepInside.agent.say('go back a chapter')
  await settle(50)
  assert.deepEqual(deepInside.player.spoken, ['Two.'], 'more than two paragraphs in means the start of this chapter')
  assert.deepEqual(deepInside.player.ranges, [{ from: 5, to: 9 }])

  const justIn = harness({ script: () => DONE, currentParagraph: 6, decide: () => ({ kind: 'previous_chapter' }) })
  justIn.agent.say('go back a chapter')
  await settle(50)
  assert.deepEqual(justIn.player.spoken, ['One.'], 'just past the boundary means the chapter before')
  assert.deepEqual(justIn.player.ranges, [{ from: 0, to: 9 }])
}

// "from the top": the whole book, from paragraph 0, with its line said once
{
  const h = harness({ script: () => DONE, currentParagraph: 8, decide: () => ({ kind: 'beginning' }) })
  h.agent.say('start over')
  await settle(50)
  assert.deepEqual(h.player.spoken, ['From the top.'])
  assert.deepEqual(h.player.ranges, [{ from: 0, to: 9 }])
  assert.deepEqual(h.chat.filter((c) => c.role === 'assistant').map((c) => c.text), ['From the top.'])
  assert.equal(h.apiCalls(), 0)
}

console.log('agent.errors.check.ts: ok')
