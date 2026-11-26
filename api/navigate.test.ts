// Self-check for fast navigation (_lib/navigate.ts) over the TypeSafe adapter.
//
// A fake vendor stands in for Jev: it records the request, so the check can see
// exactly what the model is asked (the state, the intent labels, one label per
// candidate document), and answers with a scripted decision so the mapping back
// to ids, chapter indexes and shelves is exercised end to end, key or no key.
// The fake is a stubbed fetch, so no socket is opened.
import assert from 'node:assert/strict'
import { describe, it, vi } from 'vitest'

process.env.TYPESAFE_API_KEY = 'test'
process.env.DECIDER_PROVIDER = 'typesafe'
delete process.env.TYPESAFE_BASE_URL // the adapter's own default endpoint
const { navigate, buildQuestions } = await import('./_lib/navigate.ts')
const { parseAnswers } = await import('./_lib/adapters/typesafe.ts')
const { override } = await import('./_lib/providers.ts')

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/** Stub fetch with a vendor that records each request and answers with `reply`. */
function fakeVendor(reply: unknown) {
  const seen: { url: string; auth: string | null; body: Record<string, unknown> }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  return seen
}

describe('buildQuestions', () => {
  it('asks for the intent, a document and a shelf on the library screen', () => {
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
  })

  it('asks for the intent and a chapter on the document screen', () => {
    const q = buildQuestions({ text: 'chapter three', screen: 'document', chapters: ['The Harbour', 'The Boat', 'The Fish'] })
    assert.deepEqual(Object.keys(q), ['intent', 'chapter'])
    const intents = Object.keys((q.intent as { criteria: object }).criteria)
    assert.ok(intents.includes('chapter') && intents.includes('close') && intents.includes('pause') && intents.includes('other'))
    const ch = q.chapter as { criteria: Record<string, string | null> }
    assert.deepEqual(Object.keys(ch.criteria), ['ch:0', 'ch:1', 'ch:2', 'none'])
    assert.equal(ch.criteria['ch:2'], 'Chapter 3: The Fish')
  })

  it('never offers more documents than the vendor takes', () => {
    const q = buildQuestions({ text: 'x', screen: 'library', docs: Array.from({ length: 400 }, (_, i) => ({ id: String(i), title: `Doc ${i}` })) })
    assert.equal(Object.keys((q.doc as { criteria: object }).criteria).length, 201)
  })
})

describe('parseAnswers', () => {
  const questions = () => buildQuestions({ text: 'x', screen: 'library', docs: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] })

  it('keeps a choice that was offered', () => {
    const parsed = parseAnswers(
      { intent: { type: 'choice', choice: 'open', confidence: 0.91, probabilities: { open: 0.91 } }, doc: { type: 'choice', choice: 'doc:b', confidence: 0.8, probabilities: {} } },
      questions(),
    )
    assert.equal((parsed.intent as { choice: string }).choice, 'open')
  })

  it('rejects a label that was not offered', () => {
    assert.throws(() => parseAnswers({ intent: { type: 'choice', choice: 'delete_everything', confidence: 1, probabilities: {} }, doc: { type: 'choice', choice: 'none', confidence: 1, probabilities: {} } }, questions()), /not offered/)
  })

  it('rejects a question left unanswered', () => {
    assert.throws(() => parseAnswers({ intent: { type: 'choice', choice: 'open', confidence: 1, probabilities: {} } }, questions()), /answered nothing/)
  })
})

describe('navigate over a fake vendor', () => {
  it('sends the state, the intent labels and one label per document, and maps the answer back to ids', async () => {
    const seen = fakeVendor({
      model: 'jev-latest',
      answers: {
        intent: { type: 'choice', choice: 'open', confidence: 0.93, probabilities: { open: 0.93, list: 0.02, other: 0.05 } },
        doc: { type: 'choice', choice: 'doc:sea', confidence: 0.88, probabilities: { 'doc:sea': 0.88, 'doc:sleep': 0.1, none: 0.02 } },
      },
      usage: { input_tokens: 120, output_tokens: 0 },
    })
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
    assert.equal(seen[0].url, ENDPOINT)
    assert.equal(seen[0].auth, 'Bearer test')
    assert.equal(seen[0].body.model, 'jev-latest')
    const state = seen[0].body.state as Record<string, unknown>
    assert.equal(state.transcript, 'open the hemingway book')
    assert.match(String(state.transcript_status), /^partial/)
    const questions = seen[0].body.questions as Record<string, { type: string; criteria: Record<string, unknown> }>
    assert.equal(questions.intent.type, 'choice')
    assert.deepEqual(Object.keys(questions.doc.criteria), ['doc:sea', 'doc:sleep', 'none'])
  })

  it('reads "none" for the document as no document, not a document called none', async () => {
    const seen = fakeVendor({ answers: { intent: { type: 'choice', choice: 'other', confidence: 0.7, probabilities: {} }, doc: { type: 'choice', choice: 'none', confidence: 0.9, probabilities: {} } } })
    const other = await navigate({ text: 'is that true?', screen: 'library', docs: [{ id: 'sea', title: 'x' }, { id: 'b', title: 'y' }] })
    assert.equal(seen[0].url, ENDPOINT)
    assert.equal(other?.intent, 'other')
    assert.equal(other?.doc, undefined)
  })

  it('maps chapters and shelves back to an index and an id', async () => {
    const seen = fakeVendor({
      answers: {
        intent: { type: 'choice', choice: 'chapter', confidence: 0.85, probabilities: {} },
        chapter: { type: 'choice', choice: 'ch:2', confidence: 0.8, probabilities: {} },
        shelf: { type: 'choice', choice: 'none', confidence: 0.95, probabilities: {} },
      },
    })
    const ch = await navigate({ text: 'skip to chapter three', screen: 'document', chapters: ['a', 'b', 'c'], shelves: [{ id: 'archive', label: 'Archive' }, { id: 'later', label: 'Later' }], open: { title: 'T' } })
    assert.equal(seen[0].url, ENDPOINT)
    assert.deepEqual(ch?.chapter, { index: 2, confidence: 0.8 })
    assert.equal(ch?.shelf, undefined)
  })
})

describe('navigate without the vendor', () => {
  it('returns null, never an error, when no decider is configured, so the client falls back to the conversation', async () => {
    vi.stubEnv('DECIDER_PROVIDER', 'none')
    assert.equal(await navigate({ text: 'open something', screen: 'library', docs: [] }), null)
  })

  it('lets a test stand in its own decider', async () => {
    override('decider', { name: 'fake', decide: async () => ({ intent: { type: 'choice', choice: 'list', confidence: 1, probabilities: {} } }) })
    try {
      assert.equal((await navigate({ text: "what's new", screen: 'library' }))?.intent, 'list')
    } finally {
      override('decider', null)
    }
  })
})
