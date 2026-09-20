// Self-check for the player's hold/release and its start watchdog. Run it with:
//
//   node --experimental-strip-types src/tts.check.ts
//
// The barge-in lives in three places — HoldGate decides, the listener fires, the
// player parks — and only the parking is here. What it has to get right: a held
// range is still a live range (read_aloud keeps waiting), a release re-speaks the
// paragraph from its start, a pause during a hold is the real interruption, and
// an engine that swallows an utterance is retried once and then reported.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// tts.ts imports expo-speech at module top. The Player never touches it (it runs
// on whatever engine setEngine() was given); SystemVoice does, and its stop
// ordering is checked below through this stub.
const SPEECH =
  'data:text/javascript,' +
  encodeURIComponent(`
const calls = []
let resolveStop = null
globalThis.__speech = {
  calls,
  finishStop() {
    const r = resolveStop
    resolveStop = null
    if (r) r()
  },
}
export function speak(text, opts) {
  calls.push('speak:' + text)
  globalThis.__speech.opts = opts
}
export function stop() {
  calls.push('stop')
  return new Promise((r) => {
    resolveStop = r
  })
}
`)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'expo-speech') return { url: SPEECH, shortCircuit: true }
    return next(spec, ctx)
  },
})

const { Player, SystemVoice, START_TIMEOUT_MS } = await import('./tts.ts')

/** hold()'s stop timeout, as tts.ts sets it. */
const STOP_TIMEOUT_MS = 300
type VoiceEngine = import('./ports.ts').VoiceEngine

const speech = (globalThis as any).__speech as { calls: string[]; finishStop: () => void }

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Let every pending microtask and zero-delay timer run. */
const tick = async () => {
  for (let i = 0; i < 4; i++) await delay(0)
}

/**
 * A voice with no audio and no timing: every utterance hangs until the test says
 * otherwise. `answersStop: false` is the engine that forgets to report a stop;
 * `starts: false` is the engine that takes the text and makes no sound.
 */
class FakeVoice implements VoiceEngine {
  readonly reportsStart = true
  spoken: string[] = []
  private settle: ((outcome: 'done' | 'stopped') => void) | null = null

  private opts: { answersStop?: boolean; starts?: boolean }

  constructor(opts: { answersStop?: boolean; starts?: boolean } = {}) {
    this.opts = opts
  }

  speak(text: string, _rate: number, o?: { onStart?: () => void }): Promise<'done' | 'stopped'> {
    this.spoken.push(text)
    return new Promise((resolve) => {
      this.settle = resolve
      if (this.opts.starts !== false) o?.onStart?.()
    })
  }

  stop() {
    if (this.opts.answersStop === false) return
    this.settle?.('stopped')
    this.settle = null
  }

  /** The utterance reaches its end on its own. */
  finish() {
    this.settle?.('done')
    this.settle = null
  }
}

function player(engine: VoiceEngine, paragraphs: string[]) {
  const p = new Player()
  p.setEngine(engine)
  p.setParagraphs(paragraphs)
  return p
}

// --- hold → release re-speaks the same paragraph -----------------------------
{
  const engine = new FakeVoice()
  const p = player(engine, ['one', 'two'])
  const playing: boolean[] = []
  p.onPlayingChange = (v) => playing.push(v)

  const range = p.playFrom(0)
  await tick()
  assert.deepEqual(engine.spoken, ['one'])

  p.hold()
  await tick()
  assert.equal(p.held, true)
  assert.equal(playing.at(-1), true, 'a held range is still a live range')
  assert.deepEqual(engine.spoken, ['one'], 'a hold speaks nothing')

  p.release()
  await tick()
  assert.equal(p.held, false)
  assert.deepEqual(engine.spoken, ['one', 'one'], 'release re-speaks the paragraph from its start')
  assert.deepEqual(playing, [false, true], 'the hold never touched `playing`')

  engine.finish() // ¶0 ends for real
  await tick()
  assert.deepEqual(engine.spoken, ['one', 'one', 'two'])
  engine.finish()
  assert.equal(await range, 'completed', 'the range survived the hold')
}

// --- pause during a hold is the real interruption; release then does nothing --
{
  const engine = new FakeVoice()
  const p = player(engine, ['a', 'b'])
  const range = p.playFrom(0)
  await tick()

  p.hold()
  await tick()
  p.pause()
  assert.equal(await range, 'stopped')

  p.release()
  await tick()
  assert.equal(p.held, false)
  assert.deepEqual(engine.spoken, ['a'], 'release after pause resumes nothing')
}

// --- an engine that never reports a stop still parks, within the timeout ------
{
  const engine = new FakeVoice({ answersStop: false })
  const p = player(engine, ['a', 'b'])
  const range = p.playFrom(0)
  await tick()

  const start = Date.now()
  p.hold()
  // `speaking` clears as the utterance settles, which is the loop reaching its park.
  while (p.speaking !== '' && Date.now() - start < 2000) await delay(10)
  const elapsed = Date.now() - start
  assert.ok(elapsed < 400, `hold settled in ${elapsed}ms, expected under 400`)
  assert.equal(p.held, true)

  p.release()
  await tick()
  assert.deepEqual(engine.spoken, ['a', 'a'])
  p.pause()
  assert.equal(await range, 'stopped')
}

// --- SystemVoice: an utterance waits for the stop it follows ------------------
{
  speech.calls.length = 0
  const voice = new SystemVoice()
  void voice.speak('one', 1)
  await tick()
  assert.deepEqual(speech.calls, ['speak:one'])

  void voice.stop()
  void voice.speak('two', 1)
  await tick()
  assert.deepEqual(speech.calls, ['speak:one', 'stop'], 'the next utterance waits on the stop')

  speech.finishStop()
  await tick()
  assert.deepEqual(speech.calls, ['speak:one', 'stop', 'speak:two'])
}

// --- an utterance that never starts is retried once, then the range fails -----
{
  const engine = new FakeVoice({ starts: false, answersStop: false })
  const p = player(engine, ['a', 'b'])
  const started = Date.now()
  const outcome = await p.playFrom(0)
  const elapsed = Date.now() - started

  assert.equal(outcome, 'failed', 'a silent engine fails the range rather than racing through it')
  assert.deepEqual(engine.spoken, ['a', 'a'], 'one retry, not a loop')
  assert.equal(p.currentIndex, 0, 'a paragraph that was never read is not left behind')
  assert.equal(p.lastFailure, 'no-audio')
  assert.ok(elapsed >= 2 * START_TIMEOUT_MS - 50, `watchdog fired too early (${elapsed}ms)`)

  // the next utterance that actually starts clears it
  const good = new FakeVoice()
  p.setEngine(good)
  const range = p.playFrom(0)
  await tick()
  assert.equal(p.lastFailure, null)
  good.finish()
  await tick()
  good.finish()
  assert.equal(await range, 'completed')
}

// --- an attempt that settles late leaves the next utterance its stop guard ----
{
  const engine = new FakeVoice({ answersStop: false })
  const p = player(engine, ['a', 'b'])
  const first = p.playFrom(0)
  await tick()

  p.pause() // ¶a's attempt will only settle when its stop timeout fires
  const range = p.playFrom(0) // the next utterance, started before that happens
  await tick()
  await delay(2 * STOP_TIMEOUT_MS) // the first attempt settles in here, late
  assert.equal(await first, 'stopped')

  const start = Date.now()
  p.hold()
  while (p.speaking !== '' && Date.now() - start < 2000) await delay(10)
  const elapsed = Date.now() - start
  assert.ok(elapsed < 400, `hold settled in ${elapsed}ms, expected under 400`)
  assert.equal(p.held, true, 'the late settle did not strip the live utterance of its guard')

  p.pause()
  assert.equal(await range, 'stopped')
}

console.log('tts.check: ok')
