// The background announcer. The state and the player are faked: each test sets
// what the agent is doing and decides how an attempt to say a line goes. What
// this pins down: a verdict never talks over the agent, waits for a paragraph
// break while the book plays, comes back after being cut off, gives up after a
// TTS outage instead of jamming the queue, and two verdicts never overlap.
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { createAnnouncer, MAX_FAILURES, RECHECK_MS, type SayOutcome } from './background.ts'
import type { AgentState } from './agent.ts'

const tick = () => new Promise<void>((r) => setImmediate(r))

function setup() {
  const log: string[] = []
  const t = {
    state: 'idle' as AgentState,
    /** What the next attempt does, interjected or spoken. */
    next: 'said' as SayOutcome,
    timers: [] as (() => void)[],
    log,
  }
  const announcer = createAnnouncer({
    agentState: () => t.state,
    interject: async (text, cue) => {
      if (t.next !== 'said') { log.push(`${t.next}:${text}`); return t.next }
      cue?.()
      log.push(`aside:${text}`)
      return 'said'
    },
    speak: async (text) => {
      log.push(t.next === 'said' ? `speak:${text}` : `${t.next}:${text}`)
      return t.next
    },
    cue: () => log.push('cue'),
    setTimeout: (fn, ms) => { assert.equal(ms, RECHECK_MS); t.timers.push(fn) },
  })
  /** Let one recheck fire. */
  const recheck = async () => {
    const fn = t.timers.shift()
    assert.ok(fn, 'expected a pending recheck')
    fn()
    await tick()
    await tick()
  }
  return { t, announcer, recheck }
}

describe('background announcer', () => {
  it('says a line at once when idle, cue first', async () => {
    const { t, announcer } = setup()
    assert.equal(await announcer.announce('verdict one'), true)
    assert.deepEqual(t.log, ['cue', 'speak:verdict one'])
    assert.equal(announcer.pending, 0)
  })

  it('hands a line to the player for the next paragraph break while reading', async () => {
    const { t, announcer } = setup()
    t.state = 'reading'
    await announcer.announce('verdict two')
    assert.deepEqual(t.log, ['cue', 'aside:verdict two'])
  })

  it('waits while the agent is busy, then says it once it goes quiet', async () => {
    const { t, announcer, recheck } = setup()
    t.state = 'speaking'
    let done = false
    void announcer.announce('verdict three').then(() => { done = true })
    await tick()
    assert.deepEqual(t.log, [])
    assert.equal(done, false)
    await recheck() // still busy
    t.state = 'thinking'
    await recheck()
    assert.deepEqual(t.log, [])
    t.state = 'idle'
    await recheck()
    assert.deepEqual(t.log, ['cue', 'speak:verdict three'])
    assert.equal(done, true)
  })

  it('tries an interjection the user talked over again', async () => {
    const { t, announcer, recheck } = setup()
    t.state = 'reading'
    t.next = 'missed'
    void announcer.announce('verdict four')
    await tick()
    assert.deepEqual(t.log, ['missed:verdict four'])
    t.state = 'listening'
    await recheck()
    assert.deepEqual(t.log, ['missed:verdict four'])
    t.state = 'reading'
    t.next = 'said'
    await recheck()
    assert.deepEqual(t.log, ['missed:verdict four', 'cue', 'aside:verdict four'])
  })

  it('tries a spoken line that was cut off again', async () => {
    const { t, announcer, recheck } = setup()
    t.next = 'missed'
    let said: boolean | undefined
    void announcer.announce('verdict five').then((s) => { said = s })
    await tick()
    t.next = 'said'
    await recheck()
    assert.deepEqual(t.log, ['cue', 'missed:verdict five', 'cue', 'speak:verdict five'])
    assert.equal(said, true)
  })

  it('drops a line whose speech keeps failing, and the next one still goes out', async () => {
    const { t, announcer, recheck } = setup()
    t.next = 'failed'
    let said: boolean | undefined
    void announcer.announce('broken').then((s) => { said = s })
    void announcer.announce('after')
    await tick()
    for (let i = 1; i < MAX_FAILURES; i++) await recheck()
    assert.equal(said, false)
    assert.equal(announcer.pending, 1)
    t.next = 'said'
    await recheck()
    assert.equal(t.log.at(-1), 'speak:after')
    assert.equal(t.log.filter((l) => l === 'failed:broken').length, MAX_FAILURES)
  })

  it('says two lines in order, one after the other', async () => {
    const { t, announcer } = setup()
    await Promise.all([announcer.announce('first'), announcer.announce('second')])
    assert.deepEqual(t.log, ['cue', 'speak:first', 'cue', 'speak:second'])
  })

  it('clear() drops what was waiting and resolves it, and the next line still goes out', async () => {
    const { t, announcer, recheck } = setup()
    t.state = 'thinking'
    let said: boolean | undefined
    void announcer.announce('stale').then((s) => { said = s })
    await tick()
    assert.equal(announcer.pending, 1)
    announcer.clear()
    await tick()
    assert.equal(announcer.pending, 0)
    assert.equal(said, false)
    t.state = 'idle'
    await recheck() // the old pump wakes and stands down
    await announcer.announce('fresh')
    assert.deepEqual(t.log, ['cue', 'speak:fresh'])
  })
})
