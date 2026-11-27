// Self-check for the Flux listener's wiring (flux.ts).
//
// The turn mapping: Flux's growing transcript is the interim, its EndOfTurn the
// utterance, and the echo filter and barge-in behave as they do for Chrome's
// recognizer. The stream: the grant that said "available" opens the socket, audio
// goes out as 80ms frames only while connected and unmuted, a dropped stream
// reconnects with a fresh grant and gives up after a few, and stopping says
// CloseStream. WebAudio and the socket are fakes; nothing leaves the process.
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

class FakeSocket {
  static OPEN = 1
  static all: FakeSocket[] = []
  readyState = 0
  sent: (string | ArrayBuffer)[] = []
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  closed = false
  constructor(
    public url: string,
    public protocols: string[],
  ) {
    FakeSocket.all.push(this)
  }
  send(d: string | ArrayBuffer) {
    this.sent.push(d)
  }
  close() {
    this.closed = true
  }
  open() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
    this.onmessage?.({ data: JSON.stringify({ type: 'Connected', request_id: 'r', sequence_id: 0 }) })
  }
  drop(code = 1011) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

const node = () => ({ connect: (n: unknown) => n, disconnect() {}, gain: { value: 1 } })
class FakeWorkletNode {
  static all: FakeWorkletNode[] = []
  port = { onmessage: null as unknown }
  connect = (n: unknown) => n
  disconnected = false
  constructor() {
    FakeWorkletNode.all.push(this)
  }
  disconnect() {
    this.disconnected = true
  }
}
const g = globalThis as any
g.window = { WebSocket: FakeSocket, AudioWorkletNode: FakeWorkletNode }
g.WebSocket = FakeSocket
g.AudioWorkletNode = FakeWorkletNode
g.AudioContext = class {
  state = 'running'
  sampleRate = 48_000
  destination = node()
  audioWorklet = { addModule: async () => {} }
  async resume() {}
  createMediaStreamSource = node
  createGain = node
}
URL.createObjectURL = () => 'blob:tap'
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [], getTracks: () => [] }) } },
  configurable: true,
})

const { FluxListener } = await import('./flux.ts')
type Grant = { url: string; protocols: string[]; expiresIn: number }

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tick = async () => {
  for (let i = 0; i < 6; i++) await delay(0)
}
const turn = (event: string, transcript: string, confidence = 0.9) => ({
  type: 'TurnInfo',
  event,
  transcript,
  words: transcript.split(' ').filter(Boolean).map((word) => ({ word, confidence })),
})

function listener(grants: () => Promise<Grant | null> = async () => ({ url: 'wss://flux', protocols: ['bearer', 't'], expiresIn: 60 })) {
  FakeSocket.all = []
  return new FluxListener(grants)
}

describe('FluxListener turns', () => {
  it('sends the growing transcript as interims and the end of turn as the utterance', () => {
    const l = listener()
    const interims: string[] = []
    const heard: string[] = []
    let starts = 0
    l.onInterim = (t) => interims.push(t)
    l.onUtterance = (t) => heard.push(t)
    l.onSpeechStart = () => starts++

    l.handle(turn('StartOfTurn', 'stop'))
    l.handle(turn('Update', 'stop reading'))
    assert.equal(starts, 0, 'two words is not enough to duck on')
    l.handle(turn('Update', 'stop reading this'))
    l.handle(turn('Update', 'stop reading this now'))
    assert.equal(starts, 1, 'once per turn')
    l.handle(turn('EndOfTurn', 'stop reading this now'))
    assert.deepEqual(interims, ['stop', 'stop reading', 'stop reading this', 'stop reading this now'])
    assert.deepEqual(heard, ['stop reading this now'])

    l.handle(turn('Update', 'go back a page'))
    assert.equal(starts, 2, 'the next turn may duck again')
  })

  it('drops the narration, keeps a command said over it, and drops a lone unsure word', () => {
    const l = listener()
    const heard: string[] = []
    const interims: string[] = []
    l.onUtterance = (t) => heard.push(t)
    l.onInterim = (t) => interims.push(t)
    l.getRecentSpokenText = () => 'they were at war with one another for a hundred years'

    l.handle(turn('Update', 'for a hundred years'))
    l.handle(turn('EndOfTurn', 'for a hundred years'))
    l.handle(turn('EndOfTurn', 'at war with one another wait go back'))
    l.handle(turn('Update', 'stop', 0.2))
    l.handle(turn('EndOfTurn', 'um', 0.2))
    l.handle(turn('EndOfTurn', 'pause', 0.95))
    assert.deepEqual(interims, [], 'neither an echo nor an unsure "stop" is an interim')
    assert.deepEqual(heard, ['wait go back', 'pause'])
  })

  it('a turn that ends with nothing releases the hold it took; a muted mic hears nothing', () => {
    const l = listener()
    let falseStarts = 0
    const heard: string[] = []
    l.onFalseStart = () => falseStarts++
    l.onUtterance = (t) => heard.push(t)

    l.handle(turn('Update', 'hang on a second'))
    l.handle(turn('EndOfTurn', ''))
    assert.equal(falseStarts, 1)

    l.setPlaying(true)
    l.level(0.4)
    l.level(0.4)
    l.setUserMuted(true)
    assert.equal(falseStarts, 2, 'muting mid-hold gives the book back')
    l.handle(turn('EndOfTurn', 'next chapter'))
    assert.deepEqual(heard, [])
  })
})

describe('FluxListener stream', () => {
  it('opens the socket with the grant that answered available(), and frames audio at 80ms', async () => {
    let asked = 0
    const l = listener(async () => (asked++, { url: 'wss://flux?x', protocols: ['bearer', 'jwt'], expiresIn: 60 }))
    assert.equal(await l.available(), true)
    await l.start()
    await tick()
    assert.equal(asked, 1, 'the first connection uses the grant already in hand')
    const ws = FakeSocket.all[0]
    assert.equal(ws.url, 'wss://flux?x')
    assert.deepEqual(ws.protocols, ['bearer', 'jwt'])

    l.audio(new Float32Array(3840)) // 80ms at 48 kHz
    assert.equal(ws.sent.length, 0, 'nothing goes out before the socket opens')
    ws.open()
    assert.equal(ws.sent.length, 1, 'what was said while it opened goes out on open')
    l.audio(new Float32Array(3840))
    assert.deepEqual(ws.sent.map((f) => (f as ArrayBuffer).byteLength), [2560, 2560])
    l.setUserMuted(true)
    l.audio(new Float32Array(3840))
    assert.equal(ws.sent.length, 2, 'muted, nothing is sent')

    l.stop()
    assert.equal(ws.sent.at(-1), '{"type":"CloseStream"}')
    assert.ok(ws.closed)
  })

  it('keeps about a second while the stream reopens, not the whole wait', async () => {
    const l = listener()
    await l.start()
    await tick()
    for (let i = 0; i < 20; i++) l.audio(new Float32Array(3840))
    const ws = FakeSocket.all[0]
    ws.open()
    assert.equal(ws.sent.length, 12)
    l.stop()
  })

  it('never leaves a second socket open behind the one it uses', async () => {
    const l = listener()
    await l.start()
    await tick()
    l.setUserMuted(true)
    FakeSocket.all[0].open()
    l.setUserMuted(false)
    ;(l as any).connect() // a second connect, as when unmuting lands during the mic prompt
    await tick()
    assert.equal(FakeSocket.all.length, 2)
    assert.ok(FakeSocket.all[0].closed, 'the first is closed')
    assert.equal(FakeSocket.all[0].sent.at(-1), '{"type":"CloseStream"}')
    l.stop()
  })

  it('says no on a 501, and "can\'t tell" on a server that fails', async () => {
    assert.equal(await listener(async () => null).available(), false)
    assert.equal(await listener(async () => Promise.reject(new Error('500'))).available(), null)
  })

  it('a capture that opens after the mic went off and on again is closed, not fed in', async () => {
    FakeWorkletNode.all = []
    const l = listener()
    const first = l.start()
    l.stop()
    const second = l.start()
    await Promise.all([first, second])
    await tick()
    const fed = FakeWorkletNode.all.filter((n) => n.port.onmessage)
    assert.equal(FakeWorkletNode.all.length, 2)
    assert.equal(fed.length, 1, 'only the live session hears the mic')
    assert.ok(FakeWorkletNode.all.find((n) => !n.port.onmessage)?.disconnected, 'the stale one is disconnected')
    assert.equal(FakeSocket.all.length, 1)
    l.stop()
  })

  it('does not retry while muted, and reconnects on unmute', async () => {
    let fail = true
    let asked = 0
    const l = listener(async () => {
      asked++
      if (fail) throw new Error('offline')
      return { url: 'wss://flux', protocols: ['bearer', 't'], expiresIn: 60 }
    })
    const errors: string[] = []
    l.onError = (m) => errors.push(m)
    l.setUserMuted(true)
    await l.start()
    await delay(1200)
    assert.equal(asked, 0, 'muted from the start, nothing is asked')
    l.setUserMuted(false)
    await tick()
    assert.equal(asked, 1)
    l.setUserMuted(true)
    await delay(1200)
    assert.equal(asked, 1, 'the retry waits for unmute')
    fail = false
    l.setUserMuted(false)
    await tick()
    assert.equal(FakeSocket.all.length, 1)
    assert.deepEqual(errors, [])
    l.stop()
  })

  it('reconnects a dropped stream with a fresh grant, and gives up after a few', async () => {
    let asked = 0
    const l = listener(async () => (asked++, { url: 'wss://flux', protocols: ['bearer', 't'], expiresIn: 60 }))
    const errors: string[] = []
    l.onError = (m) => errors.push(m)
    await l.start()
    await tick()
    FakeSocket.all[0].open()
    FakeSocket.all[0].drop()
    await delay(550)
    await tick()
    assert.equal(FakeSocket.all.length, 2, 'one retry after the first drop')
    assert.equal(asked, 2, 'each connection gets its own grant')

    FakeSocket.all[1].drop()
    await delay(1050)
    await tick()
    FakeSocket.all[2].drop()
    await delay(2050)
    await tick()
    assert.deepEqual(errors, [])
    FakeSocket.all[3].drop()
    assert.equal(errors.length, 1, 'the fourth failure in a row stops and says so')
    await delay(600)
    assert.equal(FakeSocket.all.length, 4, 'and nothing reconnects after')
  })

  it('a stream Flux closes while muted reconnects on unmute, not before', async () => {
    const l = listener()
    await l.start()
    await tick()
    FakeSocket.all[0].open()
    l.setUserMuted(true)
    FakeSocket.all[0].drop(1000)
    await delay(600)
    assert.equal(FakeSocket.all.length, 1)
    l.setUserMuted(false)
    await tick()
    assert.equal(FakeSocket.all.length, 2)
    l.stop()
  })

  it('reports each stream\'s seconds of audio when it ends, cleanly or not', async () => {
    const l = listener()
    const seen: { port: string; ok: boolean; units?: { seconds: number } }[] = []
    l.onMeasure = (e) => seen.push(e as never)
    await l.start()
    await tick()
    l.audio(new Float32Array(3840)) // held while opening, sent on open
    FakeSocket.all[0].open()
    for (let i = 0; i < 9; i++) l.audio(new Float32Array(3840))
    FakeSocket.all[0].drop(1011)
    assert.deepEqual(seen.map((e) => [e.port, e.ok, e.units?.seconds]), [['listen', false, 0.8]])
    await delay(600) // reconnects
    FakeSocket.all[1].open()
    l.audio(new Float32Array(3840))
    l.stop()
    assert.deepEqual(seen.map((e) => [e.ok, e.units?.seconds]), [[false, 0.8], [true, 0.08]])
    l.stop()
    assert.equal(seen.length, 2, 'a stream is reported once')
  })
})

describe('FluxListener barge-in measurements', () => {
  it('reports a level hold that words followed, and a words-path stop timed from the loud run', () => {
    const l = listener()
    const seen: unknown[] = []
    l.onMeasure = (e) => seen.push({ port: e.port, provider: e.provider, ok: e.ok })
    l.setPlaying(true)
    l.level(0.4)
    l.level(0.4)
    l.handle(turn('Update', 'hold on'))
    l.handle(turn('EndOfTurn', 'hold on'))
    l.level(0.4) // one loud report: no hold
    l.level(0.01)
    l.handle(turn('Update', 'go back a bit'))
    assert.deepEqual(seen, [
      { port: 'bargein', provider: 'level', ok: true },
      { port: 'bargein', provider: 'words', ok: true },
    ])
  })
})
