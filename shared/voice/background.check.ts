// Self-check for the background announcer. Run it with:
//
//   node --experimental-strip-types shared/voice/background.check.ts
//
// The state and the player are faked: the test sets what the agent is doing and
// decides whether an interjection lands. What this pins down: a verdict never
// talks over the agent, waits for a paragraph break while the book plays, comes
// back after being cut off, and two verdicts never overlap.
import assert from 'node:assert/strict'
import { createAnnouncer, RECHECK_MS } from './background.ts'
import type { AgentState } from './agent.ts'

const tick = () => new Promise<void>((r) => setImmediate(r))

function setup() {
  const log: string[] = []
  const t = {
    state: 'idle' as AgentState,
    /** What the next interjection does: land, or get cut off. */
    interjectLands: true,
    timers: [] as (() => void)[],
    log,
  }
  const announcer = createAnnouncer({
    agentState: () => t.state,
    interject: async (text, cue) => {
      if (!t.interjectLands) { log.push(`cut:${text}`); return false }
      cue?.()
      log.push(`aside:${text}`)
      return true
    },
    speak: async (text) => { log.push(`speak:${text}`) },
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

// idle: said at once, with the cue first
{
  const { t, announcer } = setup()
  await announcer.announce('verdict one')
  assert.deepEqual(t.log, ['cue', 'speak:verdict one'])
  assert.equal(announcer.pending, 0)
}

// reading: handed to the player for the next paragraph break
{
  const { t, announcer } = setup()
  t.state = 'reading'
  await announcer.announce('verdict two')
  assert.deepEqual(t.log, ['cue', 'aside:verdict two'])
}

// the agent is talking: wait, then say it once it goes quiet
{
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
}

// cut off by the user: tried again, not lost
{
  const { t, announcer, recheck } = setup()
  t.state = 'reading'
  t.interjectLands = false
  void announcer.announce('verdict four')
  await tick()
  assert.deepEqual(t.log, ['cut:verdict four'])
  t.state = 'listening'
  await recheck()
  assert.deepEqual(t.log, ['cut:verdict four'])
  t.state = 'reading'
  t.interjectLands = true
  await recheck()
  assert.deepEqual(t.log, ['cut:verdict four', 'cue', 'aside:verdict four'])
}

// two at once: in order, one after the other
{
  const { t, announcer } = setup()
  await Promise.all([announcer.announce('first'), announcer.announce('second')])
  assert.deepEqual(t.log, ['cue', 'speak:first', 'cue', 'speak:second'])
}

// clear(): a new document drops what was waiting, and the next line still goes out
{
  const { t, announcer, recheck } = setup()
  t.state = 'thinking'
  void announcer.announce('stale')
  await tick()
  assert.equal(announcer.pending, 1)
  announcer.clear()
  assert.equal(announcer.pending, 0)
  t.state = 'idle'
  await recheck() // the old pump wakes and stands down
  await announcer.announce('fresh')
  assert.deepEqual(t.log, ['cue', 'speak:fresh'])
}

console.log('background announcer: ok')
