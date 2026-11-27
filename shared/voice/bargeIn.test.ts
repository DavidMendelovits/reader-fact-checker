// Tests for level-gated barge-in.
//
// Three regressions live here. (1) Waiting for three recognized words meant the
// first words of an interruption played over the book. (2) The old `talking` flag
// was set on speech start and cleared only by a final, so when the recognizer was
// torn down mid-utterance nothing ever cleared it and barge-in died for the rest
// of the session. (3) Releasing on a timer rather than on silence cut a long
// sentence off mid-word, because the transcript had not arrived yet.
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { BargeInGate } from './bargeIn.ts'

// A fake clock: nothing here waits on real time.
function clock() {
  let now = 0
  let seq = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++seq
      pending.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (id: number) => {
      pending.delete(id)
    },
    /** Advance, firing whatever comes due on the way. */
    advance(ms: number) {
      const until = now + ms
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null
        for (const entry of pending) if (entry[1].at <= until && (!next || entry[1].at < next[1].at)) next = entry
        if (!next) break
        pending.delete(next[0])
        now = next[1].at
        next[1].fn()
      }
      now = until
    },
  }
}

function gate(over: { floor?: number; reportsToFire?: number; silenceMs?: number } = {}) {
  const c = clock()
  const g = new BargeInGate({ ...over, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout })
  const holds: number[] = []
  const releases: number[] = []
  g.onHold = () => holds.push(c.now())
  g.onRelease = () => releases.push(c.now())
  return { c, g, holds, releases }
}

describe('BargeInGate', () => {
  it('two reports at or above the floor, while playing, fire the hold', () => {
    const { g, holds } = gate()
    g.level(0.4, true)
    assert.deepEqual(holds, [], 'one report is a door closing, not a barge-in')
    assert.equal(g.held, false)
    g.level(0.4, true)
    assert.equal(holds.length, 1)
    assert.equal(g.held, true)
  })

  it('a single loud report between quiet ones never accumulates', () => {
    const { g, holds } = gate()
    g.level(0.4, true)
    g.level(0.1, true)
    g.level(0.4, true)
    g.level(0.05, true)
    assert.deepEqual(holds, [])
  })

  it('nothing to barge in on when nothing is playing', () => {
    const { g, holds } = gate()
    for (let i = 0; i < 20; i++) g.level(0.9, false)
    assert.deepEqual(holds, [])
    assert.equal(g.held, false)
  })

  it('a cough: held, then 1.5s under the floor with no words releases it', () => {
    const { c, g, holds, releases } = gate()
    g.level(0.4, true)
    g.level(0.4, true)
    assert.equal(holds.length, 1)
    c.advance(1499)
    assert.equal(g.held, true, 'released before the silence was up')
    c.advance(1)
    assert.deepEqual(releases, [1500])
    assert.equal(g.held, false)
  })

  // a long sentence the recognizer has not transcribed yet
  it('the level keeps the hold alive for as long as the user keeps talking', () => {
    const { c, g, releases } = gate()
    g.level(0.4, true)
    g.level(0.4, true)
    for (let t = 0; t < 3000; t += 80) {
      c.advance(80)
      g.level(0.6, true)
    }
    assert.deepEqual(releases, [], 'cut off a user who was still talking')
    assert.equal(g.held, true)
    // and it still releases once they actually stop
    c.advance(1500)
    assert.equal(g.held, false)
    assert.equal(releases.length, 1)
  })

  it('words() cancels the auto-release: the turn is real, the caller owns it', () => {
    const { c, g, releases } = gate()
    g.level(0.4, true)
    g.level(0.4, true)
    g.words()
    c.advance(10000)
    assert.deepEqual(releases, [], 'released a hold that had words in it')
    assert.equal(g.held, true)
    // quiet after the words must not re-arm the countdown either
    g.level(0.0, true)
    c.advance(10000)
    assert.deepEqual(releases, [])
  })

  // so the next speech start fires again rather than the book never stopping for
  // the rest of the session
  it('the recognizer dying mid-hold clears the run counter', () => {
    const { g, holds, releases } = gate()
    g.level(0.4, true)
    g.level(0.4, true)
    g.words()
    g.reset()
    assert.equal(g.held, false)
    assert.equal(releases.length, 1, 'stranded the player on a dead recognizer')
    g.level(0.4, true)
    g.level(0.4, true)
    assert.equal(holds.length, 2, 'barge-in died after a recognizer restart')
  })

  it('the floor and the run length are tunable', () => {
    const { g, holds } = gate({ floor: 0.5, reportsToFire: 3 })
    g.level(0.4, true)
    g.level(0.4, true)
    g.level(0.4, true)
    assert.deepEqual(holds, [], 'fired under the floor')
    g.level(0.6, true)
    g.level(0.6, true)
    assert.deepEqual(holds, [])
    g.level(0.6, true)
    assert.equal(holds.length, 1)
  })

  // the gate used to stay `sawWords` until the recognizer ended, so it fired once
  // and then never again for the rest of the session
  it('two utterances in one recognizer session each get their own hold', () => {
    const { c, g, holds, releases } = gate()
    g.level(0.4, true)
    g.level(0.4, true)
    assert.equal(holds.length, 1)
    g.words()
    g.utteranceDone() // the final was handed to the caller
    assert.equal(g.held, false, 'the gate lets go of an utterance it has handed on')
    assert.deepEqual(releases, [], 'without resuming anything: that hold became the interruption')

    c.advance(10000) // a while later, in the same session
    g.level(0.4, true)
    g.level(0.4, true)
    assert.equal(holds.length, 2, 'the second utterance holds too')
  })
})

// The client meter's view of barge-in: one report per barge-in, timed from the
// first loud report of the run, and marked a false start when no words came.
describe('BargeInGate measurements', () => {
  function measured(over: { silenceMs?: number } = {}) {
    const t = gate(over)
    const seen: { path: string; ms: number; real: boolean }[] = []
    t.g.onMeasure = (m) => seen.push(m)
    return { ...t, seen }
  }

  it('times a level hold from the first loud report and reports it real once words come', () => {
    const { c, g, seen } = measured()
    g.level(0.1, true)
    c.advance(80)
    g.level(0.4, true) // the run starts here
    c.advance(80)
    g.level(0.4, true) // the hold fires here
    assert.deepEqual(seen, [], 'not known to be real yet')
    g.words()
    g.words() // every interim calls it; one report
    g.utteranceDone()
    assert.deepEqual(seen, [{ path: 'level', ms: 80, real: true }])
  })

  it('reports a hold the silence released as a false start', () => {
    const { c, g, seen, releases } = measured({ silenceMs: 1500 })
    g.level(0.4, true)
    c.advance(80)
    g.level(0.4, true)
    g.level(0.1, true)
    c.advance(1600)
    assert.equal(releases.length, 1)
    assert.deepEqual(seen, [{ path: 'level', ms: 80, real: false }])
  })

  it('counts a final with no interim before it as words', () => {
    const { c, g, seen } = measured()
    g.level(0.4, true)
    c.advance(80)
    g.level(0.4, true)
    g.utteranceDone()
    assert.deepEqual(seen, [{ path: 'level', ms: 80, real: true }])
  })

  it('reports a recognizer that ended mid-hold as a false start', () => {
    const { c, g, seen } = measured()
    g.level(0.4, true)
    c.advance(80)
    g.level(0.4, true)
    g.reset()
    assert.deepEqual(seen, [{ path: 'level', ms: 80, real: false }])
  })

  it('times a words-path stop from the latest loud run while narration plays', () => {
    const { c, g, seen } = measured()
    g.level(0.4, true) // one loud report: the run starts, the hold does not fire
    c.advance(80)
    g.level(0.1, true)
    c.advance(500)
    g.wordsHold()
    g.wordsHold()
    assert.deepEqual(seen, [{ path: 'words', ms: 580, real: true }])
    g.utteranceDone()
    c.advance(80)
    g.level(0.4, true)
    c.advance(80)
    g.level(0.1, true)
    g.wordsHold()
    assert.equal(seen.length, 2, 'the next utterance is measured afresh')
  })

  it('does not time a words-path stop with nothing playing or no recent loud run', () => {
    const { c, g, seen } = measured()
    g.level(0.1, true)
    g.wordsHold()
    g.level(0.4, false)
    g.wordsHold()
    assert.deepEqual(seen, [], 'nothing was playing')
    g.level(0.4, true)
    g.level(0.1, true)
    c.advance(5000)
    g.level(0.1, true)
    g.wordsHold()
    assert.deepEqual(seen, [], 'the loud run is too old to time from')
  })
})
