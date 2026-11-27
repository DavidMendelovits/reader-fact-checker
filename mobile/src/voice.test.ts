// Tests for the phone listener's wiring.
// The decisions themselves are checked next to the policies (shared/voice's
// bargeIn, restartPolicy and echo tests). What is checked here is that this file
// hands them the right things: levels only count while narration plays, a hold
// released by the recognizer ending reports a false start, a final that is half
// narration keeps its other half, and a recognizer dying on arrival three times
// turns the mic off instead of respawning forever.
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { VoiceListener } from './voice.ts'

type Rec = {
  calls: string[]
  granted: boolean
  emit(name: string, ev?: unknown): void
  reset(): void
  handler(name: string, i: number): ((ev?: unknown) => void) | undefined
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

test('the level gate holds only while narration is playing', async () => {
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
})

test('a final that is half narration keeps the other half', async () => {
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
})

test('the three-word interim stays as a fallback, and `talking` resets', async () => {
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
})

test('a recognizer that dies on arrival three times turns the mic off', async () => {
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
})

test('a denied permission stops rather than spinning', async () => {
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
})

test('a hold taken by the word path is released when the recognizer ends', async () => {
  const l = await listener()
  let starts = 0
  let falseStarts = 0
  l.onSpeechStart = () => starts++
  l.onFalseStart = () => falseStarts++

  // no level reports: the gate never holds, so only the three-word fallback does
  rec.emit('result', { results: [{ transcript: 'stop reading this' }], isFinal: false })
  assert.equal(starts, 1, 'the word path took the hold')

  rec.emit('end')
  assert.equal(falseStarts, 1, 'a hold the gate never took is still released when the ear dies')
  l.stop()
})

test('an end from a session that has been replaced does not spawn', async () => {
  const l = await listener()
  const starts = () => rec.calls.filter((c) => c === 'start').length
  const stale = rec.handler('end', 0) // this session's end handler

  rec.emit('end') // the session dies; the policy respawns
  await delay(400)
  assert.equal(starts(), 2, 'the routine end respawned')

  stale?.() // the dead session's end, arriving late
  await delay(400)
  assert.equal(starts(), 2, 'a stale end does not start a second recognizer under the live one')
  l.stop()
})

