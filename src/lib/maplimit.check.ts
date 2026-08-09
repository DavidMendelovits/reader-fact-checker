// Self-check for the bounded-concurrency helper behind the whole-document scan.
//
//   node --experimental-strip-types src/lib/maplimit.check.ts
//
// Concurrency bugs here are silent: too many in flight rate-limits the API, too few
// is the serial version we just removed, and a lost item means a claim never gets
// checked and nothing says so.
import assert from 'node:assert/strict'
import { mapLimit } from './maplimit.ts'

const tick = () => new Promise((r) => setTimeout(r, 1))

// every item runs exactly once, results keep input order
{
  const seen: number[] = []
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    seen.push(n)
    await tick()
    return n * 10
  })
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70])
  assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7])
}

// never more than `limit` in flight, and it does actually reach `limit`
{
  let inFlight = 0
  let peak = 0
  await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
    peak = Math.max(peak, ++inFlight)
    await tick()
    inFlight--
  })
  assert.equal(peak, 4, `peak concurrency was ${peak}`)
}

// cancelling stops picking up work; skipped slots are holes, not undefined values
{
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
}

// degenerate inputs must not hang or spawn zero workers
assert.deepEqual(await mapLimit([], 3, async () => 1), [])
assert.deepEqual(await mapLimit([1, 2], 0, async (n) => n), [1, 2])

console.log('mapLimit: ok')
