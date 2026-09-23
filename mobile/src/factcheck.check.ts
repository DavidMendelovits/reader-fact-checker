// Self-check for reading /api/factcheck's NDJSON. Run it with:
//
//   node --experimental-strip-types src/factcheck.check.ts
import assert from 'node:assert/strict'
import { NOTHING_USABLE, parseFactCheck } from './factcheck.ts'

const result = {
  verdict: 'Mostly true',
  summary: 'He did fish alone.',
  spokenSummary: 'Mostly true: he did fish alone.',
  sources: [{ title: 'Hemingway', url: 'https://example.com/h' }],
}

// the ordinary answer: deltas, then done
{
  const body =
    `${JSON.stringify({ type: 'delta', text: 'Mostly' })}\n` +
    `${JSON.stringify({ type: 'delta', text: ' true' })}\n` +
    `${JSON.stringify({ type: 'done', result })}\n`
  assert.deepEqual(parseFactCheck(body), { result }, 'the done line is the answer')
}

// an error line is the answer, with its own words
{
  const body = `${JSON.stringify({ type: 'error', error: 'the checker is down' })}\n`
  assert.deepEqual(parseFactCheck(body), { error: 'the checker is down' })
  // an error with nothing to say still says something
  assert.deepEqual(parseFactCheck(`${JSON.stringify({ type: 'error' })}\n`), { error: NOTHING_USABLE })
}

// garbage and a half-written line are skipped, not fatal
{
  const body =
    'not json at all\n' +
    '{"type":"delta","text":"half\n' +
    '\n' +
    `${JSON.stringify({ type: 'done', result })}\n`
  assert.deepEqual(parseFactCheck(body), { result }, 'unparseable lines are skipped')
  // …and nothing usable after them is an error, not a crash
  assert.deepEqual(parseFactCheck('not json at all\n{"type":"delta","text":"half\n'), { error: NOTHING_USABLE })
}

// nothing at all
{
  assert.deepEqual(parseFactCheck(''), { error: NOTHING_USABLE })
  assert.deepEqual(parseFactCheck('\n\n'), { error: NOTHING_USABLE })
  // a done with no result is not an answer
  assert.deepEqual(parseFactCheck(`${JSON.stringify({ type: 'done' })}\n`), { error: NOTHING_USABLE })
}

// the first done wins
{
  const second = { ...result, verdict: 'False' }
  const body = `${JSON.stringify({ type: 'done', result })}\n${JSON.stringify({ type: 'done', result: second })}\n`
  assert.deepEqual(parseFactCheck(body), { result })
}

console.log('factcheck.check.ts: ok')
