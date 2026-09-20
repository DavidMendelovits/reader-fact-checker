// Self-check for the phone listener's wiring. Run it with:
//
//   node --experimental-strip-types src/voice.check.ts
//
// The decisions themselves are checked next to the policies (bargeIn.check.ts,
// restartPolicy.check.ts, echo.check.ts). What is checked here is that this file
// hands them the right things: levels only count while narration plays, a hold
// released by the recognizer ending reports a false start, a final that is half
// narration keeps its other half, and a recognizer dying on arrival three times
// turns the mic off instead of respawning forever.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const REC =
  'data:text/javascript,' +
  encodeURIComponent(`
const handlers = {}
const calls = []
globalThis.__rec = {
  calls,
  granted: true,
  emit(name, ev) {
    for (const h of handlers[name] || []) h(ev)
  },
  reset() {
    for (const k of Object.keys(handlers)) delete handlers[k]
    calls.length = 0
    globalThis.__rec.granted = true
  },
}
export const ExpoSpeechRecognitionModule = {
  addListener(name, fn) {
    handlers[name] = handlers[name] || []
    handlers[name].push(fn)
    return { remove() {} }
  },
  start() {
    calls.push('start')
  },
  stop() {
    calls.push('stop')
  },
  async requestPermissionsAsync() {
    return { granted: globalThis.__rec.granted }
  },
}
`)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'expo-speech-recognition') return { url: REC, shortCircuit: true }
    return next(spec, ctx)
  },
})

const { VoiceListener } = await import('./voice.ts')

type Rec = {
  calls: string[]
  granted: boolean
  emit(name: string, ev?: unknown): void
  reset(): void
}
const rec = (globalThis as any).__rec as Rec

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tick = async () => {
  for (let i = 0; i < 4; i++) await delay(0)
}

/** A started listener, with the stub cleared of the previous block's handlers. */
async function listener() {
  rec.reset()
  const l = new VoiceListener()
  await l.start()
  await tick()
  assert.deepEqual(rec.calls, ['start'])
  return l
}

/** The recognizer's raw scale: -2..10, so 4 is a voice and 0 is a quiet room. */
const LOUD = 4
const QUIET = 0

// --- the level gate holds only while narration is playing --------------------
{
  const l = await listener()
  let starts = 0
  let falseStarts = 0
  l.onSpeechStart = () => starts++
  l.onFalseStart = () => falseStarts++

  rec.emit('volumechange', { value: LOUD })
  rec.emit('volumechange', { value: LOUD })
  assert.equal(starts, 0, 'nothing to barge in on while nothing is playing')

  l.setPlaying(true)
  rec.emit('volumechange', { value: LOUD })
  assert.equal(starts, 0, 'one loud report is a door closing')
  rec.emit('volumechange', { value: LOUD })
  assert.equal(starts, 1, 'two in a row is a voice')
  rec.emit('volumechange', { value: QUIET })
  assert.equal(starts, 1, 'the hold is not re-fired')

  // the recognizer ending under a hold releases it rather than stranding the book
  rec.emit('end')
  assert.equal(falseStarts, 1)
  l.stop()
}

// --- a final that is half narration keeps the other half ----------------------
{
  const l = await listener()
  const heard: string[] = []
  l.onUtterance = (t) => heard.push(t)
  l.getRecentSpokenText = () => 'they were at war with one another for a hundred years'

  rec.emit('result', { results: [{ transcript: 'at war with one another wait go back' }], isFinal: true })
  assert.deepEqual(heard, ['wait go back'], 'the command survives the echo it arrived inside')

  rec.emit('result', { results: [{ transcript: 'for a hundred years' }], isFinal: true })
  assert.deepEqual(heard, ['wait go back'], 'a whole echo is still dropped')

  rec.emit('result', { results: [{ transcript: 'open the next chapter' }], isFinal: true })
  assert.deepEqual(heard, ['wait go back', 'open the next chapter'])
  l.stop()
}

// --- the three-word interim stays as a fallback, and `talking` resets ---------
{
  const l = await listener()
  let starts = 0
  const interim: string[] = []
  l.onSpeechStart = () => starts++
  l.onInterim = (t) => interim.push(t)

  rec.emit('result', { results: [{ transcript: 'stop' }], isFinal: false })
  assert.equal(starts, 0, 'one word is not enough to duck on')
  rec.emit('result', { results: [{ transcript: 'stop reading this' }], isFinal: false })
  assert.equal(starts, 1)
  rec.emit('result', { results: [{ transcript: 'stop reading this now' }], isFinal: false })
  assert.equal(starts, 1, 'once per utterance')
  assert.deepEqual(interim, ['stop', 'stop reading this', 'stop reading this now'])

  // no-speech ends the utterance; without the reset, barge-in dies for the session
  rec.emit('error', { error: 'no-speech' })
  rec.emit('result', { results: [{ transcript: 'wait go back' }], isFinal: false })
  assert.equal(starts, 2)
  l.stop()
}

// --- a recognizer that dies on arrival three times turns the mic off ----------
{
  const l = await listener()
  const errors: string[] = []
  l.onError = (m) => errors.push(m)

  rec.emit('end')
  rec.emit('end')
  assert.deepEqual(errors, [], 'two deaths still get a restart')
  rec.emit('end')
  assert.deepEqual(errors, ['Voice recognition keeps failing — tap the mic to try again'])

  await delay(400) // well past the respawn delay
  assert.equal(
    rec.calls.filter((c) => c === 'start').length,
    1,
    'the pending restart was cancelled with the session',
  )
  l.stop()
}

// --- a denied permission stops rather than spinning --------------------------
{
  rec.reset()
  rec.granted = false
  const l = new VoiceListener()
  const errors: string[] = []
  l.onError = (m) => errors.push(m)
  await l.start()
  await tick()
  assert.deepEqual(errors, ['Microphone access denied'])
  assert.equal(rec.calls.includes('start'), false)
  l.stop()
}

console.log('voice.check: ok')
