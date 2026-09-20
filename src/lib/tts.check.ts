// Self-check for the web player's hold/release. Run it with:
//
//   node --experimental-strip-types src/lib/tts.check.ts
//
// The streaming half of this player needs a browser (MediaSource, WebAudio) and
// is not checked here; the hold is not browser work — it is which paragraph the
// loop comes back to — so it runs on a fake <audio> element. CAN_STREAM is false
// under node, so playback takes the cached-blob path, which is also the path a
// release takes on a prefetched paragraph.
import assert from 'node:assert/strict'

/** The two-line <audio> the player actually uses: play, pause, onended. */
class FakeAudio {
  static last: FakeAudio | null = null
  src = ''
  playbackRate = 1
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  playing = false

  constructor() {
    FakeAudio.last = this
  }

  play(): Promise<void> {
    this.playing = true
    return Promise.resolve()
  }

  pause(): void {
    this.playing = false
  }

  /** The clip reaches its end. */
  end(): void {
    this.playing = false
    this.onended?.()
  }
}
;(globalThis as any).Audio = FakeAudio
// audio-levels only rewires a *running* context, so a suspended one is the quiet
// way to say "no meter here" — it takes the same early return as a real browser
// that hasn't had a user gesture yet.
;(globalThis as any).AudioContext = class {
  state = 'suspended'
  async resume() {}
}

const { TtsPlayer } = await import('./tts.ts')
type AudioSource = import('./ports.ts').AudioSource

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tick = async () => {
  for (let i = 0; i < 6; i++) await delay(0)
}

const source: AudioSource = { synthesize: async () => new Response('mp3') }

function player(paragraphs: string[]) {
  const p = new TtsPlayer(source)
  p.clearCacheForNewDoc() // the blob cache is module-global; each block starts clean
  p.setParagraphs(paragraphs)
  return p
}

// --- hold → release replays the same paragraph -------------------------------
{
  const p = player(['one', 'two'])
  const seen: number[] = []
  const playing: boolean[] = []
  p.onParagraphChange = (i) => seen.push(i)
  p.onPlayingChange = (v) => playing.push(v)

  const range = p.playFrom(0)
  await tick()
  assert.deepEqual(seen, [0])
  assert.equal(FakeAudio.last?.playing, true)

  p.hold()
  assert.equal(p.held, true)
  assert.equal(FakeAudio.last?.playing, false, 'a hold stops the audio')
  assert.equal(playing.at(-1), true, 'a held range is still a live range')
  await tick()
  assert.deepEqual(seen, [0], 'a hold advances nothing')

  p.release()
  await tick()
  assert.equal(p.held, false)
  assert.deepEqual(seen, [0, 0], 'release replays the paragraph the hold parked on')
  assert.deepEqual(playing, [true], 'the hold never touched `playing`')
  assert.equal(FakeAudio.last?.playing, true)

  FakeAudio.last?.end()
  await tick()
  assert.deepEqual(seen, [0, 0, 1])
  FakeAudio.last?.end()
  assert.equal(await range, 'completed', 'the range survived the hold')
}

// --- pause during a hold is the real interruption; release then does nothing --
{
  const p = player(['a', 'b'])
  const seen: number[] = []
  p.onParagraphChange = (i) => seen.push(i)

  const range = p.playFrom(0)
  await tick()
  p.hold()
  await tick()
  p.pause()
  assert.equal(await range, 'stopped')

  p.release()
  await tick()
  assert.equal(p.held, false)
  assert.deepEqual(seen, [0], 'release after pause resumes nothing')
}

console.log('tts.check: ok')
