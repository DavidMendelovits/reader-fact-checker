// Self-check for the streaming sentence splitter. Run it with:
//
//   node --experimental-strip-types src/lib/sentences.check.ts
//
// The splitter decides when the first sentence of a reply goes to the synthesizer,
// so a false boundary means the voice reads half a sentence, stops, and starts
// again — worse than waiting. Every case here feeds the text in awkward chunks, the
// way a token stream actually arrives.
import assert from 'node:assert/strict'
import { SentenceSplitter } from './sentences.ts'

/** Feed `text` through a fresh splitter in chunks of `n` chars and collect the output. */
function split(text: string, n = 3): string[] {
  const s = new SentenceSplitter()
  const out: string[] = []
  for (let i = 0; i < text.length; i += n) out.push(...s.push(text.slice(i, i + n)))
  const tail = s.flush()
  if (tail) out.push(tail)
  return out
}

assert.deepEqual(split('Let me check that. One moment.'), ['Let me check that.', 'One moment.'])
assert.deepEqual(split('Is that right? It is! Really.'), ['Is that right?', 'It is!', 'Really.'])

// nothing is emitted until whitespace confirms the boundary — the stream may be mid-word
{
  const s = new SentenceSplitter()
  assert.deepEqual(s.push('Sure thing.'), [])
  assert.deepEqual(s.push(' Reading'), ['Sure thing.'])
  assert.deepEqual(s.push(' on from chapter two.'), [])
  assert.equal(s.flush(), 'Reading on from chapter two.')
}

// abbreviations and initials are not boundaries
assert.deepEqual(split('Mr. Darcy arrives at Mt. Pleasant. He is late.'), [
  'Mr. Darcy arrives at Mt. Pleasant.',
  'He is late.',
])
assert.deepEqual(split('J. R. R. Tolkien wrote it. True.'), ['J. R. R. Tolkien wrote it.', 'True.'])
assert.deepEqual(split('Use e.g. this one. Done.'), ['Use e.g. this one.', 'Done.'])

// closing quotes ride with the sentence they end
assert.deepEqual(split('He said "no." Then he left.'), ['He said "no."', 'Then he left.'])

// ellipses and multiple marks
assert.deepEqual(split('Well... maybe. Yes!!'), ['Well...', 'maybe.', 'Yes!!'])

// whitespace-only and empty input
assert.deepEqual(split('   '), [])
assert.equal(new SentenceSplitter().flush(), null)

// chunk size must not change the result
for (const n of [1, 2, 5, 11, 100]) {
  assert.deepEqual(split('Let me check that. One moment please.', n), ['Let me check that.', 'One moment please.'])
}

console.log('sentences.check: ok')
