// The Meter (_lib/meter.ts): every port comes out of providers() timed, with the
// units it billed and, where the price table knows the model, what it cost.
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'vitest'
import { agentTurn, type AgentContext } from './_impl.ts'
import { providers, override } from './_lib/providers.ts'
import { PRICES, tokenCost, useMeter } from './_lib/meter.ts'
import type { ConversationModel, MeterEvent, SearchModel, SpeechSynthesizer } from './_lib/ports.ts'

const context: AgentContext = { title: 'T', totalParagraphs: 1, currentParagraph: 0, chapters: [], rate: 1, nearbyText: '[0] x' }

function capture() {
  const events: MeterEvent[] = []
  useMeter({ record: (e) => events.push(e) })
  return events
}

afterEach(() => {
  useMeter(null)
  for (const port of ['conversation', 'search', 'speech'] as const) override(port, null)
})

describe('the meter', () => {
  it('records a conversation turn with its time to first text, tokens and cost', async () => {
    const events = capture()
    const usage = { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 0 }
    override('conversation', {
      name: 'mock',
      turn: async (_req, hooks) => {
        await new Promise((r) => setTimeout(r, 5))
        hooks?.onText?.('Hi')
        return { content: [{ type: 'text', text: 'Hi' }], usage, model: 'claude-sonnet-5' }
      },
    } as ConversationModel)
    const heard: string[] = []
    await agentTurn([{ role: 'user', content: 'hi' }], context, (t) => heard.push(t))
    assert.deepEqual(heard, ['Hi'], 'the text still reaches the caller')
    const [e] = events
    assert.equal(e.port, 'conversation')
    assert.equal(e.provider, 'mock')
    assert.equal(e.model, 'claude-sonnet-5')
    assert.equal(e.ok, true)
    assert.ok(e.firstMs! >= 4 && e.firstMs! <= e.ms)
    assert.deepEqual(e.units, usage)
    // 1000 in at $2, 200 out at $10, 5000 cached at $0.20, per million
    assert.equal(e.cost, (1000 * 2 + 200 * 10 + 5000 * 0.2) / 1e6)
  })

  it('records a failed call and still throws it', async () => {
    const events = capture()
    override('conversation', { name: 'mock', turn: async () => { throw new Error('overloaded') } } as ConversationModel)
    await assert.rejects(agentTurn([{ role: 'user', content: 'hi' }], context), /overloaded/)
    assert.equal(events[0].ok, false)
  })

  it('counts the characters each speech request carries and keeps what stitching reads', async () => {
    const events = capture()
    const synth: SpeechSynthesizer = {
      name: 'mock',
      mimeType: 'audio/mpeg',
      maxChars: 300,
      synthesize: async () => ({ mimeType: 'audio/mpeg', body: new ReadableStream() }),
    }
    override('speech', synth)
    const speech = providers().speech
    assert.equal(speech.maxChars, 300)
    await speech.synthesize('hello')
    assert.deepEqual(events[0].units, { chars: 5 })
    assert.equal(events[0].port, 'speech')
  })

  it('times a search to its first streamed text', async () => {
    const events = capture()
    override('search', {
      name: 'mock',
      answer: async (_req, onDelta) => (onDelta?.('{'), { text: '{}', sources: [] }),
    } as SearchModel)
    await providers().search.answer({ system: '', user: '', schema: {} }, () => {})
    assert.equal(events[0].port, 'search')
    assert.equal(typeof events[0].firstMs, 'number')
  })

  it('records a call that worked once, even when the sink then throws', async () => {
    const events: MeterEvent[] = []
    useMeter({ record: (e) => { events.push(e); throw new Error('sink broke') } })
    override('search', { name: 'mock', answer: async () => ({ text: '{}', sources: [] }) } as SearchModel)
    await assert.rejects(providers().search.answer({ system: '', user: '', schema: {} }), /sink broke/)
    assert.deepEqual(events.map((e) => e.ok), [true], 'not a second event saying it failed')
  })

  it('prices only the models it knows', () => {
    const u = { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }
    assert.equal(tokenCost('claude-opus-5-5', u), PRICES['claude-opus-5-5'].input)
    assert.equal(tokenCost('claude-opus-5-5-20261101', u), PRICES['claude-opus-5-5'].input, 'a dated id')
    assert.equal(tokenCost('claude-sonnet-5-5', u), PRICES['claude-sonnet-5-5'].input)
    assert.equal(tokenCost('claude-sonnet-5-20261001', { ...u, input: 0, cacheRead: 1e6 }), PRICES['claude-sonnet-5'].cacheRead)
    assert.equal(tokenCost('claude-sonnet-50', u), undefined)
    assert.equal(tokenCost('someone-elses-model', u), undefined)
    assert.equal(tokenCost(undefined, u), undefined)
  })
})
