// The browser's timings (_lib/clientMeter.ts): recorded into the meter with the
// app that sent them, rebuilt from checked fields only, and a body with one
// event the server doesn't know refused whole.
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'vitest'
import { LIMITS, recordClientEvents } from './_impl.ts'
import { useMeter } from './_lib/meter.ts'
import type { MeterEvent } from './_lib/ports.ts'

function capture() {
  const events: MeterEvent[] = []
  useMeter({ record: (e) => events.push(e) })
  return events
}

afterEach(() => useMeter(null))

describe('client meter events', () => {
  it('records barge-in, first audio and listen events, marked with the app', () => {
    const events = capture()
    const problem = recordClientEvents({
      client: 'web',
      events: [
        { port: 'bargein', provider: 'level', ms: 162.4, ok: false },
        { port: 'first_audio', provider: 'reply', ms: 1400, ok: true },
        { port: 'listen', provider: 'deepgram', ms: 61_000, ok: true, units: { seconds: 58.08 } },
      ],
    })
    assert.equal(problem, null)
    assert.deepEqual(events, [
      { port: 'bargein', provider: 'level', client: 'web', ms: 162, ok: false },
      { port: 'first_audio', provider: 'reply', client: 'web', ms: 1400, ok: true },
      { port: 'listen', provider: 'deepgram', client: 'web', ms: 61_000, ok: true, units: { seconds: 58.1 } },
    ])
  })

  it('passes nothing through but the checked fields', () => {
    const events = capture()
    recordClientEvents({ client: 'mallory', events: [{ port: 'first_audio', provider: 'narration', ms: 900, ok: true, cost: 99, note: 'x' }] })
    assert.deepEqual(events, [{ port: 'first_audio', provider: 'narration', client: 'web', ms: 900, ok: true }])
  })

  it('refuses the whole body for one event it does not know', () => {
    const events = capture()
    const ok = { port: 'bargein', provider: 'words', ms: 300, ok: true }
    const bad = [
      { ...ok, port: 'conversation' }, // a server port: the browser can't report those
      { ...ok, provider: 'openai' },
      { ...ok, ms: -1 },
      { ...ok, ms: Number.POSITIVE_INFINITY },
      { ...ok, ms: '300' },
      { ...ok, ok: 'yes' },
      { ...ok, units: { seconds: 3 } }, // seconds only on listen
      { port: 'listen', provider: 'deepgram', ms: 1000, ok: true, units: { seconds: 1, chars: 5 } },
      { port: 'listen', provider: 'deepgram', ms: 1000, ok: true, units: { seconds: 99_999 } },
      null,
    ]
    for (const e of bad) assert.equal(recordClientEvents({ events: [ok, e] })?.status, 400, JSON.stringify(e))
    assert.deepEqual(events, [])
  })

  it('wants one to fifty events', () => {
    const one = { port: 'bargein', provider: 'level', ms: 100, ok: true }
    assert.equal(recordClientEvents({ events: [] })?.status, 400)
    assert.equal(recordClientEvents({})?.status, 400)
    assert.equal(recordClientEvents('{"events":[]}')?.status, 400)
    capture()
    assert.equal(recordClientEvents({ events: Array(50).fill(one) }), null)
    assert.equal(recordClientEvents({ events: Array(51).fill(one) })?.status, 400)
  })

  it('has a door of its own in the guard', () => {
    assert.ok(LIMITS.meter.perMinute > 0 && LIMITS.meter.maxChars >= 50 * 120)
  })
})
