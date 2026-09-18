// Self-check for fast navigation (_lib/navigate.ts) over the TypeSafe adapter.
// Run it with:
//
//   node --experimental-strip-types --import ./scripts/resolve-ts.mjs api/navigate.check.ts
//
// A fake vendor stands in for Jev: it records the request, so the check can see
// exactly what the model is asked (the state, the intent labels, one label per
// candidate document), and answers with a scripted decision so the mapping back
// to ids, chapter indexes and shelves is exercised end to end, key or no key.
import assert from 'node:assert/strict'
import http from 'node:http'

process.env.TYPESAFE_API_KEY = 'test'
process.env.DECIDER_PROVIDER = 'typesafe'
const { navigate, buildQuestions } = await import('./_lib/navigate.ts')
const { parseAnswers } = await import('./_lib/adapters/typesafe.ts')
const { override } = await import('./_lib/providers.ts')

// ---- the questions ----
{
  const q = buildQuestions({
    text: 'open the hemingway one',
    screen: 'library',
    docs: [{ id: 'a', title: 'The Old Man and the Sea', author: 'Ernest Hemingway' }, { id: 'b', title: 'Why We Sleep' }],
    shelves: [{ id: 'new', label: 'Inbox' }, { id: 'archive', label: 'Archive' }],
  })
  assert.deepEqual(Object.keys(q), ['intent', 'doc', 'shelf'])
  assert.equal(q.intent.type, 'choice')
  assert.deepEqual(Object.keys((q.intent as { criteria: object }).criteria), ['open', 'list', 'other'])
  const doc = q.doc as { criteria: Record<string, string | null> }
  assert.deepEqual(Object.keys(doc.criteria), ['doc:a', 'doc:b', 'none'])
  assert.equal(doc.criteria['doc:a'], 'The Old Man and the Sea — Ernest Hemingway')
  assert.equal(doc.criteria['doc:b'], 'Why We Sleep')
  assert.deepEqual(Object.keys((q.shelf as { criteria: object }).criteria), ['shelf:new', 'shelf:archive', 'none'])
}
{
  const q = buildQuestions({ text: 'chapter three', screen: 'document', chapters: ['The Harbour', 'The Boat', 'The Fish'] })
  assert.deepEqual(Object.keys(q), ['intent', 'chapter'])
  const intents = Object.keys((q.intent as { criteria: object }).criteria)
  assert.ok(intents.includes('chapter') && intents.includes('close') && intents.includes('pause') && intents.includes('other'))
  const ch = q.chapter as { criteria: Record<string, string | null> }
  assert.deepEqual(Object.keys(ch.criteria), ['ch:0', 'ch:1', 'ch:2', 'none'])
  assert.equal(ch.criteria['ch:2'], 'Chapter 3: The Fish')
}
// never more than the vendor takes
{
  const q = buildQuestions({ text: 'x', screen: 'library', docs: Array.from({ length: 400 }, (_, i) => ({ id: String(i), title: `Doc ${i}` })) })
  assert.equal(Object.keys((q.doc as { criteria: object }).criteria).length, 201)
}

// ---- the adapter's parsing ----
{
  const questions = buildQuestions({ text: 'x', screen: 'library', docs: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] })
  const parsed = parseAnswers(
    { intent: { type: 'choice', choice: 'open', confidence: 0.91, probabilities: { open: 0.91 } }, doc: { type: 'choice', choice: 'doc:b', confidence: 0.8, probabilities: {} } },
    questions,
  )
  assert.equal((parsed.intent as { choice: string }).choice, 'open')
  assert.throws(() => parseAnswers({ intent: { type: 'choice', choice: 'delete_everything', confidence: 1, probabilities: {} }, doc: { type: 'choice', choice: 'none', confidence: 1, probabilities: {} } }, questions), /not offered/)
  assert.throws(() => parseAnswers({ intent: { type: 'choice', choice: 'open', confidence: 1, probabilities: {} } }, questions), /answered nothing/)
}

// ---- the whole pipe over a fake vendor ----
const seen: { auth: string | undefined; body: Record<string, unknown> }[] = []
let reply: unknown = {}
const vendor = http.createServer((req, res) => {
  let data = ''
  req.on('data', (c) => (data += c))
  req.on('end', () => {
    assert.equal(req.url, '/v1/systemone')
    seen.push({ auth: req.headers.authorization, body: JSON.parse(data) })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(reply))
  })
})
await new Promise<void>((r) => vendor.listen(0, r))
const port = (vendor.address() as { port: number }).port
process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${port}`

reply = {
  model: 'jev-latest',
  answers: {
    intent: { type: 'choice', choice: 'open', confidence: 0.93, probabilities: { open: 0.93, list: 0.02, other: 0.05 } },
    doc: { type: 'choice', choice: 'doc:sea', confidence: 0.88, probabilities: { 'doc:sea': 0.88, 'doc:sleep': 0.1, none: 0.02 } },
  },
  usage: { input_tokens: 120, output_tokens: 0 },
}
const decision = await navigate({
  text: 'open the hemingway book',
  screen: 'library',
  partial: true,
  docs: [{ id: 'sea', title: 'The Old Man and the Sea', author: 'Ernest Hemingway' }, { id: 'sleep', title: 'Why We Sleep', author: 'Matthew Walker' }],
})
assert.ok(decision)
assert.equal(decision.intent, 'open')
assert.equal(decision.confidence, 0.93)
assert.deepEqual(decision.doc, { id: 'sea', confidence: 0.88 })
assert.equal(decision.model, 'typesafe')
assert.equal(seen.length, 1)
assert.equal(seen[0].auth, 'Bearer test')
assert.equal(seen[0].body.model, 'jev-latest')
const state = seen[0].body.state as Record<string, unknown>
assert.equal(state.transcript, 'open the hemingway book')
assert.match(String(state.transcript_status), /^partial/)
const questions = seen[0].body.questions as Record<string, { type: string; criteria: Record<string, unknown> }>
assert.equal(questions.intent.type, 'choice')
assert.deepEqual(Object.keys(questions.doc.criteria), ['doc:sea', 'doc:sleep', 'none'])

// "none" for the document means no document, not a document called none
reply = { answers: { intent: { type: 'choice', choice: 'other', confidence: 0.7, probabilities: {} }, doc: { type: 'choice', choice: 'none', confidence: 0.9, probabilities: {} } } }
const other = await navigate({ text: 'is that true?', screen: 'library', docs: [{ id: 'sea', title: 'x' }, { id: 'b', title: 'y' }] })
assert.equal(other?.intent, 'other')
assert.equal(other?.doc, undefined)

// chapters and shelves map back to an index and an id
reply = {
  answers: {
    intent: { type: 'choice', choice: 'chapter', confidence: 0.85, probabilities: {} },
    chapter: { type: 'choice', choice: 'ch:2', confidence: 0.8, probabilities: {} },
    shelf: { type: 'choice', choice: 'none', confidence: 0.95, probabilities: {} },
  },
}
const ch = await navigate({ text: 'skip to chapter three', screen: 'document', chapters: ['a', 'b', 'c'], shelves: [{ id: 'archive', label: 'Archive' }, { id: 'later', label: 'Later' }], open: { title: 'T' } })
assert.deepEqual(ch?.chapter, { index: 2, confidence: 0.8 })
assert.equal(ch?.shelf, undefined)

// no decider configured: null, never an error — the client falls back to the conversation
process.env.DECIDER_PROVIDER = 'none'
assert.equal(await navigate({ text: 'open something', screen: 'library', docs: [] }), null)
// and a test can stand in its own
override('decider', { name: 'fake', decide: async () => ({ intent: { type: 'choice', choice: 'list', confidence: 1, probabilities: {} } }) })
assert.equal((await navigate({ text: "what's new", screen: 'library' }))?.intent, 'list')
override('decider', null)

vendor.close()
console.log('navigate.check: ok')
