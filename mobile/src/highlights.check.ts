// Self-check for highlight anchoring and run splitting. Run it with:
//
//   node --experimental-strip-types src/highlights.check.ts
//
// Highlights arrive as text — from the agent, a long-press, or Reader — and the
// text never quite matches the paragraph: Reader straightens quotes, the agent
// lowercases, a copy-paste carries newlines. Anchoring has to find the passage
// anyway, and the offsets it returns must index the ORIGINAL paragraph, or the
// paint lands one character off. Splitting turns those offsets into runs; a run
// boundary off by one shows as a half-highlighted word.
import assert from 'node:assert/strict'
import { anchorText, splitRuns } from './highlights.ts'

const paragraphs = [
  'Call me Ishmael. Some years ago—never mind how long precisely—having little or no money in my purse.',
  'It is a way I have of driving off the spleen and regulating the circulation.',
  'The old man said, “I’m tired,” and the boy nodded. The sea was calm that morning.',
  'The sea was calm that morning, and the old man went out alone in his skiff.',
]

// exact match
{
  const a = anchorText(paragraphs, 'Some years ago')
  assert.deepEqual(a, { paragraph: 0, start: 17, end: 31 })
  assert.equal(paragraphs[0].slice(a!.start, a!.end), 'Some years ago')
}

// case and smart-quote/dash differences still match, and the offsets index the original text
{
  const original = '“I’m tired,” and the boy nodded'
  const a = anchorText(paragraphs, '"i\'m TIRED," and the boy nodded')
  assert.ok(a, 'straight quotes should match curly ones')
  assert.equal(a.paragraph, 2)
  assert.equal(paragraphs[2].slice(a.start, a.end), original)
}
{
  const original = 'ago—never mind how long precisely—having'
  const a = anchorText(paragraphs, 'ago - never mind how long precisely - having'.replace(/ - /g, '-'))
  assert.ok(a, 'a hyphen should match an em dash')
  assert.equal(paragraphs[0].slice(a.start, a.end), original)
  // and the other direction: the paragraph has a plain hyphen, the query an en dash
  const b = anchorText(['A well-known fact.'], 'well–known')
  assert.deepEqual(b, { paragraph: 0, start: 2, end: 12 })
}

// whitespace differences: newlines and double spaces in the passage still match the paragraph
{
  const a = anchorText(paragraphs, 'driving off\nthe   spleen and\n\tregulating')
  assert.ok(a)
  assert.equal(paragraphs[1].slice(a.start, a.end), 'driving off the spleen and regulating')
  // leading and trailing whitespace is ignored
  assert.deepEqual(anchorText(paragraphs, '  Call me Ishmael.  '), { paragraph: 0, start: 0, end: 16 })
}

// the same text in two paragraphs: the hinted one wins, and the search fans out from the hint
{
  const text = 'The sea was calm that morning'
  assert.equal(anchorText(paragraphs, text)?.paragraph, 2) // no hint: first in document order
  assert.equal(anchorText(paragraphs, text, 3)?.paragraph, 3)
  assert.equal(anchorText(paragraphs, text, 2)?.paragraph, 2)
  assert.equal(anchorText(paragraphs, text, 99)?.paragraph, 2) // out-of-range hint: document order
  const a = anchorText(paragraphs, text, 3)!
  assert.equal(paragraphs[3].slice(a.start, a.end), text)
}

// a passage that runs past the end of its paragraph is anchored by its opening and painted to the end
{
  const spanning = 'Some years ago—never mind how long precisely—having little or no money in my purse. It is a way I have of driving off'
  const a = anchorText(paragraphs, spanning)
  assert.ok(a)
  assert.equal(a.paragraph, 0)
  assert.equal(a.start, 17)
  assert.equal(a.end, paragraphs[0].length)
}

// too short to anchor by opening, or simply not there: null
assert.equal(anchorText(paragraphs, ''), null)
assert.equal(anchorText(paragraphs, '   '), null)
assert.equal(anchorText(paragraphs, 'zz'), null)
assert.equal(anchorText(paragraphs, 'this sentence appears nowhere in the paragraphs at all'), null)
assert.equal(anchorText([], 'Call me Ishmael'), null)
// a short passage whose opening is under twelve characters: no fuzzy fallback
assert.equal(anchorText(paragraphs, 'Call me Bob'), null)

// ---- splitRuns ----

type Mark = { id: string; start: number; end: number }
const text = 'abcdefghij'
const ids = (runs: { mark: Mark | null }[]) => runs.map((r) => r.mark?.id ?? null)

// no marks: one plain run
assert.deepEqual(splitRuns(text, [] as Mark[]), [{ text, mark: null }])
assert.deepEqual(splitRuns('', [] as Mark[]), [{ text: '', mark: null }])

// a mark in the middle: plain, painted, plain
{
  const runs = splitRuns(text, [{ id: 'm', start: 3, end: 6 }])
  assert.deepEqual(runs.map((r) => r.text), ['abc', 'def', 'ghij'])
  assert.deepEqual(ids(runs), [null, 'm', null])
}

// a mark covering the whole text: one painted run, no empty plain runs around it
{
  const runs = splitRuns(text, [{ id: 'm', start: 0, end: 10 }])
  assert.deepEqual(runs.map((r) => r.text), [text])
  assert.deepEqual(ids(runs), ['m'])
}

// overlapping marks: the overlap goes to whichever starts first; the later keeps its tail
{
  const runs = splitRuns(text, [
    { id: 'late', start: 3, end: 8 },
    { id: 'early', start: 0, end: 5 },
  ])
  assert.deepEqual(runs.map((r) => r.text), ['abcde', 'fgh', 'ij'])
  assert.deepEqual(ids(runs), ['early', 'late', null])
  // a mark entirely inside another disappears into it
  const inner = splitRuns(text, [
    { id: 'outer', start: 1, end: 7 },
    { id: 'inner', start: 2, end: 4 },
  ])
  assert.deepEqual(ids(inner), [null, 'outer', null])
  // same start: the longer one wins
  const tie = splitRuns(text, [
    { id: 'short', start: 2, end: 4 },
    { id: 'long', start: 2, end: 6 },
  ])
  assert.deepEqual(tie.map((r) => r.text), ['ab', 'cdef', 'ghij'])
  assert.deepEqual(ids(tie), [null, 'long', null])
}

// marks are clipped to the text; empty and inverted ranges are ignored
{
  const runs = splitRuns(text, [{ id: 'm', start: -5, end: 50 }])
  assert.deepEqual(runs, [{ text, mark: { id: 'm', start: 0, end: 10 } }])
  const tail = splitRuns(text, [{ id: 'm', start: 8, end: 20 }])
  assert.deepEqual(tail.map((r) => r.text), ['abcdefgh', 'ij'])
  assert.deepEqual(splitRuns(text, [{ id: 'empty', start: 4, end: 4 }]), [{ text, mark: null }])
  assert.deepEqual(splitRuns(text, [{ id: 'inverted', start: 6, end: 2 }]), [{ text, mark: null }])
  assert.deepEqual(splitRuns(text, [{ id: 'past', start: 20, end: 30 }]), [{ text, mark: null }])
}

// runs always concatenate back to the original text, whatever the marks
{
  const cases: Mark[][] = [
    [],
    [{ id: 'a', start: 0, end: 3 }],
    [{ id: 'a', start: 0, end: 3 }, { id: 'b', start: 3, end: 6 }, { id: 'c', start: 6, end: 10 }],
    [{ id: 'a', start: 2, end: 9 }, { id: 'b', start: 4, end: 5 }, { id: 'c', start: 8, end: 12 }],
    [{ id: 'a', start: -1, end: 1 }, { id: 'b', start: 9, end: 99 }],
  ]
  for (const marks of cases) {
    assert.equal(splitRuns(text, marks).map((r) => r.text).join(''), text)
    assert.ok(splitRuns(text, marks).every((r) => r.text.length > 0), 'empty run')
  }
}

// anchor → runs, end to end: what gets painted is the passage
{
  const a = anchorText(paragraphs, '"I\'m tired,"')!
  const runs = splitRuns(paragraphs[2], [{ id: 'h', ...a }])
  assert.equal(runs.find((r) => r.mark)?.text, '“I’m tired,”')
}

console.log('highlights.check: ok')
