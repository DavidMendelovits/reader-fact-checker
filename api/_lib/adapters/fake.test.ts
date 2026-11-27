// The end-to-end test environment's adapters (fake.ts, loaded by `npm run dev:e2e`).
// Each fake stands behind its port and the real route code runs on it, so a
// browser or device test against dev:e2e gets a working session. If one of
// these breaks, the e2e environment is broken, not the app.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { override } from '../providers.ts'
import { fakeConversation, fakeJson, fakeSearch, fakeSpeech } from './fake.ts'
import { agentTurn, extractClaims, factcheckNdjson, ttsStream, type AgentContext } from '../../_impl.ts'

const context: AgentContext = {
  title: 'Walls',
  totalParagraphs: 2,
  currentParagraph: 0,
  chapters: [],
  rate: 1,
  nearbyText: '[0] The Great Wall is visible from the Moon.\n\n[1] It was built over centuries.',
}

describe('e2e environment fakes', () => {
  beforeEach(() => {
    override('conversation', fakeConversation())
    override('json', fakeJson())
    override('search', fakeSearch({ delayMs: 0 }))
    override('speech', fakeSpeech())
  })
  afterEach(() => {
    for (const port of ['conversation', 'json', 'search', 'speech'] as const) override(port, null)
  })

  it('agent: greets and reads when a document opens', async () => {
    const out = await agentTurn([{ role: 'user', content: '[The reader just opened this document and is listening. Take it from here.]' }], context)
    assert.deepEqual(out.content.map((b) => b.type), ['text', 'tool_use'])
    assert.equal((out.content[1] as { name: string }).name, 'read_aloud')
  })

  it('agent: "is that true?" checks the claim and keeps reading', async () => {
    const out = await agentTurn([{ role: 'user', content: 'wait, is that true?' }], context)
    const tools = out.content.filter((b) => b.type === 'tool_use').map((b) => (b as { name: string }).name)
    assert.deepEqual(tools, ['fact_check', 'read_aloud'])
  })

  it('agent: "switch to" searches, opens the first match, then reads', async () => {
    const tools = (out: Awaited<ReturnType<typeof agentTurn>>) =>
      out.content.filter((b) => b.type === 'tool_use').map((b) => b as { name: string; input: Record<string, unknown> })
    const result = (text: string) => ({ role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 't', content: text }] })

    const [search] = tools(await agentTurn([{ role: 'user', content: 'switch to the long storm' }], context))
    assert.deepEqual([search.name, search.input], ['search_library', { query: 'the long storm' }])
    const [open] = tools(await agentTurn([result('[fake-storm] The Long Storm by Ada Writer (8 min left)')], context))
    assert.deepEqual([open.name, open.input], ['open_document', { id: 'fake-storm' }])
    const [read] = tools(await agentTurn([result('Opened "The Long Storm". Position: paragraph 4.')], context))
    assert.deepEqual([read.name, read.input], ['read_aloud', {}])
  })

  it('fact check: streams a verdict and marks it as offline', async () => {
    const lines: { type: string; result?: { verdict: string; spokenSummary: string } }[] = []
    await factcheckNdjson('The Great Wall is visible from the Moon.', (l) => lines.push(JSON.parse(l)))
    assert.ok(lines.some((l) => l.type === 'delta'), 'the verdict streams')
    const done = lines.at(-1)!
    assert.equal(done.type, 'done')
    assert.equal(done.result?.verdict, 'unverifiable')
    assert.match(done.result!.spokenSummary, /Offline check/)
  })

  it('claims: finds none', async () => {
    assert.deepEqual(await extractClaims('anything'), [])
  })

  it('speech: silent MP3 frames, a few at least', async () => {
    const audio = new Uint8Array(await (await ttsStream('Hello there, reader.')).arrayBuffer())
    assert.deepEqual([...audio.slice(0, 2)], [0xff, 0xfb], 'an MP3 frame header')
    assert.ok(audio.length >= 4 * 104)
  })
})
