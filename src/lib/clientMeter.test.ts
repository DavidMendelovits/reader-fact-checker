// The browser half of the client meter (clientMeter.ts): events batched to the
// server, and the first sound after a turn handed to the model timed once.
import assert from 'node:assert/strict'
import { afterEach, describe, it, vi } from 'vitest'
import { ClientMeter, FirstAudio, type ClientEvent } from './clientMeter.ts'

const event: ClientEvent = { port: 'bargein', provider: 'level', ms: 160, ok: true }

afterEach(() => vi.useRealTimers())

describe('ClientMeter', () => {
  it('sends a full batch at once, and a short one when the half minute runs out', () => {
    vi.useFakeTimers()
    const sent: ClientEvent[][] = []
    const m = new ClientMeter((events) => sent.push(events))
    for (let i = 0; i < 20; i++) m.record(event)
    assert.deepEqual(sent.map((b) => b.length), [20])
    m.record(event)
    vi.advanceTimersByTime(29_000)
    assert.equal(sent.length, 1)
    vi.advanceTimersByTime(1_000)
    assert.deepEqual(sent.map((b) => b.length), [20, 1])
    vi.advanceTimersByTime(60_000)
    assert.equal(sent.length, 2, 'an empty queue sends nothing')
  })

  it('sends what is queued when flushed, and nothing twice', () => {
    vi.useFakeTimers()
    const sent: ClientEvent[][] = []
    const m = new ClientMeter((events) => sent.push(events))
    m.record(event)
    m.flush()
    vi.advanceTimersByTime(30_000)
    m.flush()
    assert.deepEqual(sent.map((b) => b.length), [1])
  })
})

describe('ClientMeter spans', () => {
  it('sends a span the clock made negative as zero, so it cannot sink the batch', () => {
    const sent: ClientEvent[][] = []
    const m = new ClientMeter((events) => sent.push(events))
    m.record({ port: 'first_audio', provider: 'reply', ms: -1500, ok: true })
    m.flush()
    assert.equal(sent[0][0].ms, 0)
  })
})

describe('FirstAudio', () => {
  it('times the first sound after a hand-off and no other', () => {
    let now = 0
    const f = new FirstAudio(() => now)
    assert.equal(f.audio('narration'), null, 'nothing was handed off')
    f.handedOff()
    now = 1200
    assert.deepEqual(f.audio('reply'), { port: 'first_audio', provider: 'reply', ms: 1200, ok: true })
    now = 1500
    assert.equal(f.audio('narration'), null, 'the reply already answered this turn')
  })

  it('drops a wait past the cap: a turn answered in silence, then a sound much later', () => {
    let now = 0
    const f = new FirstAudio(() => now, 20_000)
    f.handedOff()
    now = 45_000
    assert.equal(f.audio('narration'), null)
  })
})
