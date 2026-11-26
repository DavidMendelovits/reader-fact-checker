// Self-check for the bounded-concurrency helper behind the whole-document scan.
//
// Concurrency bugs here are silent: too many in flight rate-limits the API, too few
// is the serial version we just removed, and a lost item means a claim never gets
// checked and nothing says so.
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { mapLimit } from './maplimit.ts'

const tick = () => new Promise((r) => setTimeout(r, 1))

describe('mapLimit', () => {
  it('runs every item exactly once and keeps results in input order', async () => {
    const seen: number[] = []
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      seen.push(n)
      await tick()
      return n * 10
    })
    assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70])
    assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7])
  })

  it('never has more than the limit in flight, and does reach the limit', async () => {
    let inFlight = 0
    let peak = 0
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      peak = Math.max(peak, ++inFlight)
      await tick()
      inFlight--
    })
    assert.equal(peak, 4, `peak concurrency was ${peak}`)
  })

  it('stops picking up work when cancelled, leaving holes for skipped slots', async () => {
    let started = 0
    let stop = false
    const out = await mapLimit(
      Array.from({ length: 50 }, (_, i) => i),
      2,
      async (i) => {
        started++
        if (started >= 4) stop = true
        await tick()
        return i
      },
      () => stop,
    )
    assert.ok(started < 50, `cancellation did not stop the run (${started} started)`)
    assert.equal(out.flat().length, started, 'flat() should drop the cancelled slots')
  })

  it('does not hang or spawn zero workers on empty input or a zero limit', async () => {
    assert.deepEqual(await mapLimit([], 3, async () => 1), [])
    assert.deepEqual(await mapLimit([1, 2], 0, async (n) => n), [1, 2])
  })
})
