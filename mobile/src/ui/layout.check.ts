// Self-check for the bookmark's offset table. Run it with:
//
//   node --experimental-strip-types src/ui/layout.check.ts
//
// Three properties keep "open at the bookmark" honest: a longer paragraph is
// never shorter, the offsets really are cumulative, and a measured row beats
// its estimate.
import assert from 'node:assert/strict'
import { estimateHeight, heightAt, offsetsFrom } from './layout.ts'

const W = 390

// ---- the estimate grows with the text ----
let previous = 0
for (const n of [1, 20, 80, 200, 500, 1200, 4000]) {
  const h = estimateHeight('x'.repeat(n), W, false)
  assert.ok(h >= previous, `estimate shrank at ${n} chars: ${h} < ${previous}`)
  previous = h
}
assert.ok(estimateHeight('x'.repeat(4000), W, false) > estimateHeight('x'.repeat(20), W, false), 'a long paragraph is taller than a short one')

// A one-line paragraph is one line plus the row's padding.
assert.equal(estimateHeight('short', W, false), 27 + 16)

// A heading carries its own space above and below.
assert.ok(estimateHeight('Chapter One', W, true) > estimateHeight('Chapter One', W, false), 'headings are taller')

// A narrower column wraps more, so the same text is taller.
assert.ok(estimateHeight('x'.repeat(400), 320, false) > estimateHeight('x'.repeat(400), 640, false), 'narrow wraps more')

// Bigger system text is taller.
assert.ok(estimateHeight('x'.repeat(400), W, false, 1.5) > estimateHeight('x'.repeat(400), W, false, 1), 'font scale grows rows')

// ---- offsets are cumulative ----
const estimates = [100, 50, 200, 75]
const cold = offsetsFrom(estimates, new Map())
assert.deepEqual(cold, [0, 100, 150, 350, 425])
assert.equal(cold.length, estimates.length + 1, 'one entry per row, plus the total')
for (let i = 1; i < cold.length; i++) assert.ok(cold[i] >= cold[i - 1], 'offsets never go backwards')

// ---- a measured row overrides its estimate ----
const warm = offsetsFrom(estimates, new Map([[1, 500]]))
assert.deepEqual(warm, [0, 100, 600, 800, 875])
assert.equal(heightAt(warm, 1), 500, 'the measured height is what the list is told')
assert.equal(heightAt(warm, 0), 100, 'unmeasured rows keep their estimate')
assert.equal(heightAt(cold, 3), 75)

// An empty document has a table with just the total in it.
assert.deepEqual(offsetsFrom([], new Map()), [0])

console.log('layout: estimates monotonic, offsets cumulative, measurements win')
