// The web player's hold/release and background lines. The streaming half of this player needs a browser (MediaSource, WebAudio) and
// is not checked here; the hold is not browser work — it is which paragraph the
// loop comes back to — so it runs on a fake <audio> element. CAN_STREAM is false
// under node, so playback takes the cached-blob path, which is also the path a
// release takes on a prefetched paragraph.
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

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

describe('TtsPlayer', () => {
  it('hold → release replays the same paragraph', async () => {
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
  })

  it('pause during a hold is the real interruption; release then does nothing', async () => {
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
  })

  it('interject: a background line waits for the paragraph break', async () => {
    const p = player(['one', 'two'])
    const seen: number[] = []
    const cues: string[] = []
    p.onParagraphChange = (i) => seen.push(i)

    assert.equal(await p.interject('nothing playing'), 'missed', 'no narration, nothing to interject into')

    const range = p.playFrom(0)
    await tick()
    let said: string | null = null
    void p.interject('the verdict', () => cues.push('cue')).then((v) => { said = v })
    await tick()
    assert.equal(said, null, 'it does not cut into the paragraph playing')
    assert.deepEqual(cues, [])

    FakeAudio.last?.end() // paragraph 0 ends: the break
    await tick()
    assert.deepEqual(cues, ['cue'])
    assert.deepEqual(seen, [0], 'paragraph 1 waits for the line')
    assert.equal(p.recentlySpoken.includes('the verdict'), true, 'the echo filter knows the line')

    FakeAudio.last?.end() // the line ends
    await tick()
    assert.equal(said, 'said')
    assert.deepEqual(seen, [0, 1], 'then the book carries on')
    FakeAudio.last?.end()
    assert.equal(await range, 'completed')
  })

  it('interject: talked over is "not said", and the book stays on its paragraph', async () => {
    const p = player(['one', 'two'])
    const seen: number[] = []
    p.onParagraphChange = (i) => seen.push(i)
    const range = p.playFrom(0)
    await tick()
    const said = p.interject('the verdict')
    FakeAudio.last?.end()
    await tick()
    p.hold() // the user starts talking over the line
    assert.equal(await said, 'missed')
    p.release()
    await tick()
    assert.deepEqual(seen, [0, 1], 'the next paragraph plays once, after the hold')
    p.pause()
    assert.equal(await range, 'stopped')
  })

  it('interject: a pause or the range ending drops the waiting line', async () => {
    const p = player(['one'])
    const range = p.playFrom(0)
    await tick()
    const said = p.interject('the verdict')
    p.pause()
    assert.equal(await said, 'missed')
    assert.equal(await range, 'stopped')

    const q = player(['one'])
    const range2 = q.playFrom(0)
    await tick()
    const said2 = q.interject('too late')
    FakeAudio.last?.end() // the last paragraph ends; no break follows
    assert.equal(await range2, 'completed')
    assert.equal(await said2, 'missed')
  })

})

describe('TtsPlayer outcomes', () => {
  it('speak() reports said, missed when cut off, failed when synthesis fails', async () => {
    const p = player([])
    const said = p.speak('a verdict')
    await tick()
    FakeAudio.last?.end()
    assert.equal(await said, 'said')

    const cut = p.speak('another verdict')
    await tick()
    p.pause() // the user starts talking
    assert.equal(await cut, 'missed')

    const broken = new TtsPlayer({ synthesize: async () => new Response('down', { status: 503 }) })
    broken.clearCacheForNewDoc()
    assert.equal(await broken.speak('a verdict'), 'failed')
  })

  it('speak() cut off by a hold (a cough) is missed, not said or failed', async () => {
    const p = player([])
    const line = p.speak('a verdict')
    await tick()
    p.hold()
    assert.equal(await line, 'missed')
    p.release()
  })

  it('interject: a line whose speech fails is reported failed and the book carries on', async () => {
    let calls = 0
    const p = new TtsPlayer({
      synthesize: async (text) => (++calls, text === 'the verdict' ? new Response('down', { status: 503 }) : new Response('mp3')),
    })
    p.clearCacheForNewDoc()
    p.setParagraphs(['one', 'two'])
    const seen: number[] = []
    p.onParagraphChange = (i) => seen.push(i)
    const range = p.playFrom(0)
    await tick()
    const outcome = p.interject('the verdict')
    FakeAudio.last?.end()
    assert.equal(await outcome, 'failed')
    await tick()
    assert.deepEqual(seen, [0, 1])
    FakeAudio.last?.end()
    assert.equal(await range, 'completed')
  })

})
