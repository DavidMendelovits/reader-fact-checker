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
import { mock } from 'node:test'

/** The few lines of <audio> the player actually uses: play, pause, load, onended. */
class FakeAudio {
  /** The element play() was last called on: the player has two, and swaps them. */
  static last: FakeAudio | null = null
  src = ''
  preload = ''
  playbackRate = 1
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  playing = false
  /** The src each play() started, in order. */
  played: string[] = []

  get paused(): boolean {
    return !this.playing
  }

  load(): void {}

  play(): Promise<void> {
    this.playing = true
    this.played.push(this.src)
    FakeAudio.last = this
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
const { KEEP_SILENCE_MS } = await import('./paradee-core.ts')
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

// --- a buffered source is synthesized and played a sentence at a time ---------
{
  const calls: string[] = []
  const buffered: AudioSource = {
    buffered: true,
    synthesize: async (text) => {
      calls.push(text)
      return new Response('wav')
    },
  }
  const p = new TtsPlayer(buffered)
  p.clearCacheForNewDoc()
  p.setGaps({ sentence: 0, paragraph: 0 }) // the pauses have their own case below
  p.setParagraphs(['First one. Second, with Dr. Who? Third!'])
  const range = p.playFrom(0)
  for (let k = 0; k < 3; k++) {
    await tick()
    FakeAudio.last?.end()
  }
  assert.equal(await range, 'completed')
  assert.deepEqual(calls, ['First one.', 'Second, with Dr. Who?', 'Third!'], 'one synthesize per sentence, in order')
}

// --- the next sentence loads in the second element while this one plays -------
{
  // the fake source finishes in the order it was asked, so the k-th object URL is
  // the k-th sentence asked for
  const asked: string[] = []
  const urls = new Map<string, string>() // object URL -> the sentence it says
  const orig = URL.createObjectURL
  URL.createObjectURL = (() => {
    const url = `blob:clip${urls.size}`
    urls.set(url, asked[urls.size])
    return url
  }) as typeof URL.createObjectURL
  const buffered: AudioSource = {
    buffered: true,
    synthesize: async (text) => {
      asked.push(text)
      return new Response('wav')
    },
  }
  const p = new TtsPlayer(buffered)
  p.clearCacheForNewDoc()
  p.setGaps({ sentence: 0, paragraph: 0 })
  p.setParagraphs(['A one. A two.', 'B one.'])
  const range = p.playFrom(0)
  await tick()
  const first = FakeAudio.last!
  assert.deepEqual(first.played.map((u) => urls.get(u)), ['A one.'])
  const spare = (p as any).spare as FakeAudio
  assert.notEqual(spare, first)
  assert.equal(urls.get(spare.src), 'A two.', 'loading while A one plays')
  assert.equal(spare.preload, 'auto')

  first.end()
  await tick()
  assert.equal(FakeAudio.last, spare, 'A two plays from the element it loaded in')
  assert.deepEqual(spare.played.map((u) => urls.get(u)), ['A two.'])
  assert.equal(urls.get(first.src), 'B one.', 'and the next paragraph loads in the other')

  // a hold mid-sentence, then release: the paragraph replays from its first sentence
  p.hold()
  assert.equal(spare.playing, false, 'the hold stops the element that is playing')
  p.setRate(1.5)
  await tick()
  p.release()
  await tick()
  assert.equal(urls.get(FakeAudio.last!.src), 'A one.')
  assert.equal(FakeAudio.last!.playbackRate, 1.5)
  FakeAudio.last!.end()
  await tick()
  assert.equal(urls.get(FakeAudio.last!.src), 'A two.')
  FakeAudio.last!.end()
  await tick()
  assert.equal(urls.get(FakeAudio.last!.src), 'B one.')
  FakeAudio.last!.end()
  assert.equal(await range, 'completed')
  URL.createObjectURL = orig
}

// --- unlock: a silent clip in each idle element, never the one playing --------
{
  const p = new TtsPlayer({ buffered: true, synthesize: async () => new Response('wav') })
  p.unlock()
  const [a, b] = [(p as any).audio, (p as any).spare] as FakeAudio[]
  assert.ok(a.played[0]?.startsWith('data:audio/wav;base64,'))
  assert.ok(b.played[0]?.startsWith('data:audio/wav;base64,'))
  await tick()
  assert.equal(a.playing || b.playing, false, 'paused again once play() was allowed')
  p.unlock()
  assert.equal(a.played.length + b.played.length, 2, 'once per element')
  // the server voice is left alone
  const server = new TtsPlayer({ synthesize: async () => new Response('mp3') })
  server.unlock()
  assert.equal(((server as any).audio as FakeAudio).played.length, 0)
}

// --- a buffered source keeps a paragraph queued ahead, the current one first --
{
  const asked: { text: string; signal?: AbortSignal }[] = []
  // a source that never finishes: what's being checked is the order things are asked for
  const slow: AudioSource = {
    buffered: true,
    synthesize: (text, signal) => {
      asked.push({ text, signal })
      return new Promise<Response>(() => {})
    },
  }
  const p = new TtsPlayer(slow)
  p.clearCacheForNewDoc()
  p.setParagraphs(['A one. A two.', 'B one. B two. B three.', 'C one. C two.', 'D one.'])
  void p.playFrom(0)
  await tick()
  assert.deepEqual(
    asked.map((a) => a.text),
    ['A one.', 'A two.', 'B one.', 'B two.', 'B three.', 'C one.'],
    'this paragraph, then all of the next, then the first sentence of the one after',
  )

  // a jump: everything not yet started is dropped and the new position asked for afresh
  void p.playFrom(2)
  await tick()
  assert.ok(asked.slice(0, 6).every((a) => a.signal?.aborted), 'the old range’s queue is dropped')
  assert.deepEqual(
    asked.slice(6).map((a) => a.text),
    ['C one.', 'C two.', 'D one.'],
    'not served from the dropped promises',
  )
  assert.ok(asked.slice(6).every((a) => !a.signal?.aborted))

  // a hold keeps the queue (release replays this paragraph); a pause drops it
  p.hold()
  assert.ok(asked.slice(6).every((a) => !a.signal?.aborted), 'a hold drops nothing')
  p.pause()
  assert.ok(asked.every((a) => a.signal?.aborted), 'a pause drops the lot')
}

// --- the server path never gets a signal --------------------------------------
{
  const signals: (AbortSignal | undefined)[] = []
  const server: AudioSource = {
    synthesize: async (_text, signal) => {
      signals.push(signal)
      return new Response('mp3')
    },
  }
  const p = new TtsPlayer(server)
  p.clearCacheForNewDoc()
  p.setParagraphs(['one', 'two', 'three'])
  void p.playFrom(0)
  await tick()
  assert.equal(signals.length, 3, 'this paragraph and two ahead, whole')
  assert.ok(signals.every((s) => s === undefined))
  p.pause()
}

// --- buffered: the pauses are the player's, and a pause cuts one short ---------
{
  // fake timers; tick() itself waits on setTimeout, so this flushes on setImmediate
  mock.timers.enable({ apis: ['setTimeout'] })
  const flush = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r))
  }
  const p = new TtsPlayer({ buffered: true, synthesize: async () => new Response('wav') })
  p.clearCacheForNewDoc()
  // the setting is the pause heard; the timer covers it less both clips' trim margins
  const margin = 2 * KEEP_SILENCE_MS
  p.setGaps({ sentence: 350 + margin, paragraph: 700 + margin })
  p.setParagraphs(['A one. A two.', 'B one.', 'C one.'])
  const seen: number[] = []
  p.onParagraphChange = (i) => seen.push(i)
  const els = [(p as any).audio, (p as any).spare] as FakeAudio[]
  const started = () => els.reduce((n, a) => n + a.played.length, 0)
  const range = p.playFrom(0)
  await flush()
  assert.equal(started(), 1)

  FakeAudio.last!.end() // A one
  await flush()
  mock.timers.tick(349)
  await flush()
  assert.equal(started(), 1, 'silent for the sentence gap')
  mock.timers.tick(1)
  await flush()
  assert.equal(started(), 2, 'A two starts once it is up')

  FakeAudio.last!.end() // A two, the paragraph's last
  await flush()
  mock.timers.tick(699)
  await flush()
  assert.equal(started(), 2, 'silent for the paragraph gap')
  assert.deepEqual(seen, [0], 'and still on paragraph A')
  mock.timers.tick(1)
  await flush()
  assert.equal(started(), 3)
  assert.deepEqual(seen, [0, 1])

  FakeAudio.last!.end() // B one
  await flush()
  mock.timers.tick(300)
  p.pause()
  assert.equal(await range, 'stopped', 'a pause mid-gap ends the range now')
  mock.timers.tick(3000)
  await flush()
  assert.equal(started(), 3, 'and nothing plays after it')
  assert.deepEqual(seen, [0, 1])
  mock.timers.reset()
}

// --- a new range replaces one mid-gap: the old resolves now, the new plays on --
{
  mock.timers.enable({ apis: ['setTimeout'] })
  const flush = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r))
  }
  const p = new TtsPlayer({ buffered: true, synthesize: async () => new Response('wav') })
  p.clearCacheForNewDoc()
  p.setParagraphs(['A one. A two.', 'B one.'])
  const playing: boolean[] = []
  p.onPlayingChange = (v) => playing.push(v)
  const els = [(p as any).audio, (p as any).spare] as FakeAudio[]
  const started = () => els.reduce((n, a) => n + a.played.length, 0)
  let outcome = ''
  void p.playFrom(0).then((o) => (outcome = o))
  await flush()
  FakeAudio.last!.end() // A one; A two waits out the sentence gap
  await flush()
  const next = p.playFrom(1)
  await flush()
  assert.equal(outcome, 'stopped', 'read_aloud hears back at once, mid-gap')
  assert.equal(started(), 2)
  assert.equal(FakeAudio.last!.playing, true, 'B one is playing')
  mock.timers.tick(3000) // the old range's gap runs out
  await flush()
  assert.equal(started(), 2, 'and A two never plays over it')
  assert.equal(FakeAudio.last!.playing, true)
  assert.equal(p.speaking, 'B one.')
  assert.deepEqual(playing, [true], '`playing` never dropped')
  FakeAudio.last!.end()
  assert.equal(await next, 'completed')
  assert.deepEqual(playing, [true, false])
  mock.timers.reset()
}

// --- server: replaced mid-synthesis and mid-clip, the same ---------------------
{
  let synthesized = (): void => {}
  const server: AudioSource = {
    synthesize: (text) =>
      text === 'zero'
        ? new Promise((r) => (synthesized = () => r(new Response('mp3'))))
        : Promise.resolve(new Response('mp3')),
  }
  const p = new TtsPlayer(server)
  p.clearCacheForNewDoc()
  p.setParagraphs(['zero', 'one', 'two'])
  const playing: boolean[] = []
  p.onPlayingChange = (v) => playing.push(v)
  const outcomes: string[] = []
  void p.playFrom(0).then((o) => outcomes.push(o)) // 'zero' is still synthesizing
  await tick()
  void p.playFrom(1).then((o) => outcomes.push(o))
  await tick()
  assert.deepEqual(outcomes, ['stopped'], 'without waiting for its synthesis')
  synthesized() // the replaced range unwinds now, late
  await tick()
  assert.equal(p.speaking, 'one', 'and leaves the new range its echo text')
  assert.equal(FakeAudio.last!.playing, true)

  const last = p.playFrom(2) // 'one' is mid-clip
  await tick()
  assert.deepEqual(outcomes, ['stopped', 'stopped'])
  assert.ok(p.recentlySpoken.includes('one'), 'the replaced clip stays echo-matchable')
  assert.equal(p.speaking, 'two')
  assert.equal(FakeAudio.last!.playing, true)
  assert.deepEqual(playing, [true])
  FakeAudio.last!.end()
  assert.equal(await last, 'completed')
  assert.deepEqual(playing, [true, false])
}

console.log('tts.check: ok')
