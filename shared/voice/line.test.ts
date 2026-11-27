// Tests for the Composer line.
//
// The priority is the whole design of the bar: one line, never two sources of
// truth, and the user's own words ahead of anything the app wants to say.
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { COPY, lineFor, type LineState } from './line.ts'

const base: LineState = {
  interim: '',
  agentState: 'idle',
  playing: false,
  lastAgentLine: null,
  lastAgentLineAt: null,
  now: 10_000,
  current: 11,
  total: 340,
  micState: 'live',
}
const at = (over: Partial<LineState>) => lineFor({ ...base, ...over })

describe('lineFor', () => {
  it('1. interim wins over everything, in italics', () => {
    assert.deepEqual(
      at({ interim: 'go back to the', agentState: 'thinking', playing: true, lastAgentLine: 'Sure.' }),
      { text: 'go back to the', italic: true },
    )
    // whitespace is not a transcript
    assert.deepEqual(at({ interim: '   ', agentState: 'listening' }), { text: 'Listening', italic: false })
  })

  it('2. listening', () => {
    assert.deepEqual(at({ agentState: 'listening', playing: true, lastAgentLine: 'Sure.' }), {
      text: 'Listening',
      italic: false,
    })
  })

  it('3. thinking', () => {
    assert.deepEqual(at({ agentState: 'thinking', playing: true, lastAgentLine: 'Sure.' }), {
      text: 'Thinking…',
      italic: false,
    })
  })

  it("4. the agent's line while it speaks, and for 3s after", () => {
    assert.deepEqual(at({ agentState: 'speaking', lastAgentLine: 'It was 1913.', lastAgentLineAt: null, playing: true }), {
      text: 'It was 1913.',
      italic: false,
    })
    assert.deepEqual(at({ lastAgentLine: 'It was 1913.', lastAgentLineAt: 10_000 - 3000, playing: true }), {
      text: 'It was 1913.',
      italic: false,
    })
    // one millisecond past the hold and reading takes the line back
    assert.deepEqual(at({ lastAgentLine: 'It was 1913.', lastAgentLineAt: 10_000 - 3001, playing: true }), {
      text: 'Reading ¶12/340',
      italic: false,
    })
  })

  it('5. reading, one-based', () => {
    assert.deepEqual(at({ playing: true }), { text: 'Reading ¶12/340', italic: false })
    assert.deepEqual(at({ playing: true, current: 0, total: 1 }), { text: 'Reading ¶1/1', italic: false })
    // 'reading' as an agent state is not special: the player owns that line
    assert.deepEqual(at({ agentState: 'reading', playing: true }), { text: 'Reading ¶12/340', italic: false })
  })

  // The reply had its beat and let go — a stale line is the bug this section
  // exists to catch: the bar used to keep the last reply up forever, so it read
  // like a gravestone hours after it was said.
  it('6. idle: a hint that depends on the mic', () => {
    assert.deepEqual(at({ lastAgentLine: 'Archived.', lastAgentLineAt: 10_000 - 3001 }), {
      text: 'Say something, or tap ⌨',
      italic: false,
    })
    assert.deepEqual(at({ lastAgentLine: 'Archived.', lastAgentLineAt: 0 }), { text: 'Say something, or tap ⌨', italic: false })
    assert.deepEqual(at({ lastAgentLine: 'Archived.', lastAgentLineAt: 10_000 - 3001, playing: true }), {
      text: 'Reading ¶12/340',
      italic: false,
    })
    // but inside the hold it is still the reply, idle or not
    assert.deepEqual(at({ lastAgentLine: 'Archived.', lastAgentLineAt: 10_000 - 2999 }), {
      text: 'Archived.',
      italic: false,
    })
    assert.deepEqual(at({}), { text: 'Say something, or tap ⌨', italic: false })
    assert.deepEqual(at({ micState: 'muted' }), { text: 'Say something, or tap ⌨', italic: false })
    assert.deepEqual(at({ micState: 'off' }), { text: 'Say something, or tap ⌨', italic: false })
    assert.deepEqual(at({ micState: 'notAsked' }), { text: 'Tap the mic to talk to it', italic: false })
    assert.deepEqual(at({ micState: 'denied' }), { text: 'Mic is off in Settings', italic: false })
    assert.deepEqual(at({ micState: 'restarting' }), { text: 'Mic restarted. Tap to retry.', italic: false })
  })

  it('7. the on-device voice loading at boot: below every mic hint, above the idle one', () => {
    assert.deepEqual(at({ voiceLoading: true }), { text: 'Loading voice…', italic: false })
    assert.deepEqual(at({ voiceLoading: true, micState: 'notAsked' }), { text: 'Tap the mic to talk to it', italic: false })
    assert.deepEqual(at({ voiceLoading: true, lastAgentLine: 'Archived.', lastAgentLineAt: 10_000 - 2999 }), { text: 'Archived.', italic: false })
    // and once the hold is over, the boot news outranks nothing but the idle hint
    assert.deepEqual(at({ voiceLoading: true, lastAgentLine: 'Archived.', lastAgentLineAt: 0 }), { text: 'Loading voice…', italic: false })
    assert.deepEqual(at({ voiceLoading: true, playing: true }), { text: 'Reading ¶12/340', italic: false })
  })

  it('the mic hint never displaces something the app is actually doing', () => {
    assert.deepEqual(at({ micState: 'denied', playing: true }), { text: 'Reading ¶12/340', italic: false })
    assert.deepEqual(at({ micState: 'restarting', playing: true }), { text: 'Reading ¶12/340', italic: false })
    assert.deepEqual(at({ micState: 'restarting', agentState: 'listening' }), { text: 'Listening', italic: false })
    assert.deepEqual(at({ micState: 'notAsked', agentState: 'thinking' }), { text: 'Thinking…', italic: false })
  })
})

// These land in an empty panel, where a trailing fragment reads like a bug.
// productName is a name, not a sentence, so it is held to the first rule only.
describe('COPY', () => {
  it('8. nothing blank, and every empty state is a finished sentence', () => {
    for (const [key, text] of Object.entries(COPY)) assert.ok(text.length > 0, `COPY.${key}: empty`)
    for (const key of ['emptyTranscript', 'emptyChecks'] as const) {
      assert.ok(/(\.|\?|\.’)$/.test(COPY[key]), `COPY.${key}: does not end in '.', '?' or '.’'`)
    }
    assert.equal(COPY.productName, 'readwithme')
  })
})
