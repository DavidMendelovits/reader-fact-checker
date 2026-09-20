// Self-check for the Composer line. Run it with:
//
//   node --experimental-strip-types shared/voice/line.check.ts
//
// The priority is the whole design of the bar: one line, never two sources of
// truth, and the user's own words ahead of anything the app wants to say.
import assert from 'node:assert/strict'
import { lineFor, type LineState } from './line.ts'

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

// 1. interim wins over everything, in italics
assert.deepEqual(
  at({ interim: 'go back to the', agentState: 'thinking', playing: true, lastAgentLine: 'Sure.' }),
  { text: 'go back to the', italic: true },
)
// whitespace is not a transcript
assert.deepEqual(at({ interim: '   ', agentState: 'listening' }), { text: 'Listening', italic: false })

// 2. listening
assert.deepEqual(at({ agentState: 'listening', playing: true, lastAgentLine: 'Sure.' }), {
  text: 'Listening',
  italic: false,
})

// 3. thinking
assert.deepEqual(at({ agentState: 'thinking', playing: true, lastAgentLine: 'Sure.' }), {
  text: 'Thinking…',
  italic: false,
})

// 4. the agent's line while it speaks, and for 3s after
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

// 5. reading, one-based
assert.deepEqual(at({ playing: true }), { text: 'Reading ¶12/340', italic: false })
assert.deepEqual(at({ playing: true, current: 0, total: 1 }), { text: 'Reading ¶1/1', italic: false })
// 'reading' as an agent state is not special: the player owns that line
assert.deepEqual(at({ agentState: 'reading', playing: true }), { text: 'Reading ¶12/340', italic: false })

// 6. idle: the last thing said, else a hint that depends on the mic
assert.deepEqual(at({ lastAgentLine: 'Archived.', lastAgentLineAt: 0 }), { text: 'Archived.', italic: false })
assert.deepEqual(at({}), { text: 'Say something, or tap ⌨', italic: false })
assert.deepEqual(at({ micState: 'muted' }), { text: 'Say something, or tap ⌨', italic: false })
assert.deepEqual(at({ micState: 'off' }), { text: 'Say something, or tap ⌨', italic: false })
assert.deepEqual(at({ micState: 'notAsked' }), { text: 'Tap the mic to talk to it', italic: false })
assert.deepEqual(at({ micState: 'denied' }), { text: 'Mic is off in Settings', italic: false })
assert.deepEqual(at({ micState: 'restarting' }), { text: 'Mic restarted. Tap to retry.', italic: false })

// 7. the on-device voice loading at boot: below every mic hint, above the idle one
assert.deepEqual(at({ voiceLoading: true }), { text: 'Loading voice…', italic: false })
assert.deepEqual(at({ voiceLoading: true, micState: 'notAsked' }), { text: 'Tap the mic to talk to it', italic: false })
assert.deepEqual(at({ voiceLoading: true, lastAgentLine: 'Archived.', lastAgentLineAt: 0 }), { text: 'Archived.', italic: false })
assert.deepEqual(at({ voiceLoading: true, playing: true }), { text: 'Reading ¶12/340', italic: false })

// the mic hint never displaces something the app is actually doing
assert.deepEqual(at({ micState: 'denied', playing: true }), { text: 'Reading ¶12/340', italic: false })
assert.deepEqual(at({ micState: 'restarting', playing: true }), { text: 'Reading ¶12/340', italic: false })
assert.deepEqual(at({ micState: 'restarting', agentState: 'listening' }), { text: 'Listening', italic: false })
assert.deepEqual(at({ micState: 'notAsked', agentState: 'thinking' }), { text: 'Thinking…', italic: false })

console.log('line: ok')
