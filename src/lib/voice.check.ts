// Self-check for the browser listener's wiring. Run it with:
//
//   node --experimental-strip-types src/lib/voice.check.ts
//
// The decisions themselves are checked next to the policies (bargeIn.check.ts,
// restartPolicy.check.ts, echo.check.ts). What is checked here is that this file
// hands them the right things: levels only count while narration plays and never
// while muted, a final that is half narration keeps its other half, and a
// recognizer dying on arrival backs off, gives up, and cancels its pending
// restart when the mic goes off.
//
// The real level feed is readLevels('mic'), which needs WebAudio; level() is
// driven directly here instead.
import assert from 'node:assert/strict'

/** Chrome's SpeechRecognition, as this file uses it. */
class FakeRec {
  static last: FakeRec | null = null
  static starts = 0
  continuous = false
  interimResults = false
  lang = ''
  onresult: ((e: any) => void) | null = null
  onerror: ((e: any) => void) | null = null
  onend: (() => void) | null = null

  constructor() {
    FakeRec.last = this
  }

  start() {
    FakeRec.starts++
  }

  stop() {}
}
;(globalThis as any).window = { webkitSpeechRecognition: FakeRec }
// getMicStream() is the one capture; a track that is not 'live' takes the same
// path as a Chrome that won't accept one.
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [] }) } },
  configurable: true,
})

const { VoiceListener } = await import('./voice.ts')

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tick = async () => {
  for (let i = 0; i < 4; i++) await delay(0)
}

/** One recognition event, shaped the way onresult reads it. */
const result = (transcript: string, isFinal: boolean, confidence = 0.9) => ({
  resultIndex: 0,
  results: [{ 0: { transcript, confidence }, isFinal }],
})

async function listener() {
  FakeRec.starts = 0
  const l = new VoiceListener()
  await l.start()
  await tick()
  assert.equal(FakeRec.starts, 1)
  return l
}

// --- the level gate holds only while narration plays, and never while muted ---
{
  const l = await listener()
  let starts = 0
  let falseStarts = 0
  l.onSpeechStart = () => starts++
  l.onFalseStart = () => falseStarts++

  l.level(0.4)
  l.level(0.4)
  assert.equal(starts, 0, 'nothing to barge in on while nothing is playing')

  l.setPlaying(true)
  l.setUserMuted(true)
  l.level(0.4)
  l.level(0.4)
  assert.equal(starts, 0, 'a muted mic hears nothing')

  l.setUserMuted(false)
  l.level(0.4)
  assert.equal(starts, 0, 'one loud report is a door closing')
  l.level(0.4)
  assert.equal(starts, 1, 'two in a row is a voice')

  // the recognizer ending under a hold releases it rather than stranding the book
  FakeRec.last?.onend?.()
  assert.equal(falseStarts, 1)
  l.stop()
}

// --- a final that is half narration keeps the other half ----------------------
{
  const l = await listener()
  const heard: string[] = []
  l.onUtterance = (t) => heard.push(t)
  l.getRecentSpokenText = () => 'they were at war with one another for a hundred years'

  FakeRec.last?.onresult?.(result('at war with one another wait go back', true))
  assert.deepEqual(heard, ['wait go back'], 'the command survives the echo it arrived inside')

  FakeRec.last?.onresult?.(result('for a hundred years', true))
  assert.deepEqual(heard, ['wait go back'], 'a whole echo is still dropped')

  FakeRec.last?.onresult?.(result('open the next chapter', true))
  assert.deepEqual(heard, ['wait go back', 'open the next chapter'])
  l.stop()
}

// --- the three-word interim stays as a fallback, and `talking` resets ---------
{
  const l = await listener()
  let starts = 0
  l.onSpeechStart = () => starts++

  FakeRec.last?.onresult?.(result('stop', false))
  assert.equal(starts, 0, 'one word is not enough to duck on')
  FakeRec.last?.onresult?.(result('stop reading this', false))
  assert.equal(starts, 1)
  FakeRec.last?.onresult?.(result('stop reading this now', false))
  assert.equal(starts, 1, 'once per utterance')

  FakeRec.last?.onerror?.({ error: 'no-speech' })
  FakeRec.last?.onresult?.(result('wait go back', false))
  assert.equal(starts, 2, 'no-speech ends the utterance')
  l.stop()
}

// --- a recognizer that dies on arrival backs off, then gives up ---------------
{
  const l = await listener()
  const errors: string[] = []
  l.onError = (m) => errors.push(m)

  const rec = FakeRec.last
  for (let i = 0; i < 7; i++) rec?.onend?.()
  assert.deepEqual(errors, [], 'seven deaths still get a restart')
  await delay(100)
  assert.equal(FakeRec.starts, 1, 'the backoff is longer than 100ms by the seventh')

  rec?.onend?.()
  assert.deepEqual(errors, ['Voice recognition keeps failing — tap the mic to try again'])
  l.stop()
}

// --- stop() cancels the pending restart --------------------------------------
{
  const l = await listener()
  FakeRec.last?.onend?.() // rapid: schedules a backed-off respawn
  l.stop()
  await delay(800)
  assert.equal(FakeRec.starts, 1, 'a stopped session never respawns')
}

// --- a denied mic stops rather than spinning ---------------------------------
{
  const l = await listener()
  const errors: string[] = []
  l.onError = (m) => errors.push(m)
  FakeRec.last?.onerror?.({ error: 'not-allowed' })
  assert.deepEqual(errors, ['Microphone access denied'])
  FakeRec.last?.onend?.()
  await delay(600)
  assert.equal(FakeRec.starts, 1)
  l.stop()
}

console.log('voice.check: ok')
