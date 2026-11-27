// Speech input on Deepgram Flux: the mic streamed straight from the page to
// Flux's WebSocket, and Flux's turn events back as the same callbacks Chrome's
// recognizer drives (voice.ts). The server only hands out a short-lived grant
// (/api/listen), so the key stays there and the audio never passes through it.
//
// What Flux changes is the end of a turn. Chrome finalizes after a beat of
// silence it picks itself; Flux decides from the words and the pause together
// (EndOfTurn) and reports a growing transcript as it goes (Update). Barge-in,
// the echo filters and the confidence guard are the ones voice.ts uses.
//
//   capture   getMicStream() (the one echo-cancelled capture) -> AudioWorklet
//   convert   float at the context's rate -> 16 kHz 16-bit PCM, 80ms frames
//   send      binary frames while connected and unmuted
//   receive   TurnInfo: Update/StartOfTurn/TurnResumed -> onInterim, EndOfTurn -> onUtterance

import { apiFetch } from './api.ts'
import { audioContext, getMicStream, readLevels, SPEECH_FLOOR } from './audio-levels.ts'
import type { Transcriber } from './ports.ts'
import { confident, countWords, MIN_INTERIM_WORDS } from './voice.ts'
import { BargeInGate } from '../../shared/voice/bargeIn.ts'
import { isEcho, stripEcho } from '../../shared/voice/echo.ts'
import { Framer, Resampler, toInt16 } from '../../shared/voice/pcm.ts'

export interface ListenGrant {
  url: string
  protocols: string[]
  expiresIn: number
}

/** One Flux server message, as far as this file reads it. */
export interface FluxMessage {
  type?: string
  event?: string
  transcript?: string
  words?: { confidence?: number }[]
}

const SAMPLE_RATE = 16_000 // what /api/listen's URL asks Flux for
const FRAME_SAMPLES = 1280 // 80ms at 16 kHz, Flux's recommended chunk
const LEVEL_INTERVAL_MS = 80
const RETRY_MS = 500
const MAX_BACKOFF_MS = 8000
const MAX_FAILURES = 4
/** A stream that ran this long was healthy; its close starts the failure count over. */
const HEALTHY_MS = 10_000

// Posts the capture in ~2048-sample batches rather than every 128-frame quantum.
const TAP = `class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i]
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0 }
      }
    }
    return true
  }
}
registerProcessor('pcm-tap', Tap)`

let tapLoaded: Promise<void> | null = null
function loadTap(ctx: AudioContext): Promise<void> {
  tapLoaded ??= ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([TAP], { type: 'application/javascript' }))).catch((e) => {
    tapLoaded = null
    throw e
  })
  return tapLoaded
}

export class FluxListener implements Transcriber {
  readonly supported = typeof window !== 'undefined' && 'WebSocket' in window && 'AudioWorkletNode' in window
  private running = false
  private userMuted = false
  private playing = false
  private talking = false
  private gen = 0
  private failures = 0
  private openedAt = 0
  private ws: WebSocket | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private meter: ReturnType<typeof setInterval> | null = null
  private bars = new Float32Array(8)
  private pipe: { src: AudioNode; tap: AudioWorkletNode; sink: AudioNode } | null = null
  private resampler = new Resampler(48_000, SAMPLE_RATE)
  private framer = new Framer(FRAME_SAMPLES)
  private spare: { grant: ListenGrant; at: number } | null = null

  private barge = new BargeInGate({
    floor: SPEECH_FLOOR,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
  })

  onUtterance: (text: string) => void = () => {}
  onInterim: (text: string) => void = () => {}
  onSpeechStart: () => void = () => {}
  onFalseStart: () => void = () => {}
  onError: (msg: string) => void = () => {}
  getSpokenText: () => string = () => ''
  getRecentSpokenText: () => string = () => ''

  constructor(private grants: () => Promise<ListenGrant | null> = fetchGrant) {
    this.barge.onHold = () => {
      this.talking = true
      this.onSpeechStart()
    }
    this.barge.onRelease = () => {
      this.talking = false
      this.onFalseStart()
    }
  }

  /**
   * Whether the server hands out grants, asked once when the mic first goes on.
   * The grant that answers it is kept for the connection that follows.
   */
  async available(): Promise<boolean> {
    if (!this.supported) return false
    try {
      const grant = await this.grants()
      if (grant) this.spare = { grant, at: Date.now() }
      return grant !== null
    } catch (e) {
      console.warn('streaming speech input unavailable; using the browser recognizer', e)
      return false
    }
  }

  async start() {
    if (this.running || !this.supported) return
    this.running = true
    this.failures = 0
    this.meter ??= setInterval(() => this.level(readLevels('mic', this.bars)), LEVEL_INTERVAL_MS)
    try {
      await this.openPipe()
    } catch (e) {
      const denied = (e as { name?: string })?.name === 'NotAllowedError'
      this.stop()
      this.onError(denied ? 'Microphone access denied' : 'Microphone unavailable')
      return
    }
    if (!this.running) return this.closePipe() // stop() landed while the capture was opening
    void this.connect()
  }

  stop() {
    this.running = false
    this.gen++
    if (this.meter !== null) clearInterval(this.meter)
    this.meter = null
    if (this.retry !== null) clearTimeout(this.retry)
    this.retry = null
    this.endTurn() // a hold outliving the mic releases rather than stranding the book
    this.disconnect()
    this.closePipe()
  }

  /**
   * Muted, nothing is sent: the stream bills by the second. Flux may close an idle
   * stream meanwhile, so unmuting reconnects if it has to.
   */
  setUserMuted(muted: boolean) {
    this.userMuted = muted
    if (muted) this.endTurn()
    else if (this.running && !this.ws && this.retry === null) void this.connect()
  }

  setPlaying(playing: boolean) {
    this.playing = playing
  }

  /** One normalized 0..1 mic level; public so the check can drive barge-in without a mic. */
  level(v: number) {
    if (this.userMuted) return
    this.barge.level(v, this.playing)
  }

  /** One server message; public so the check can drive a turn without a socket. */
  handle(msg: FluxMessage) {
    if (msg.type === 'Error') return console.warn('[flux]', msg) // the close that follows reconnects
    if (msg.type !== 'TurnInfo' || this.userMuted) return
    const text = (msg.transcript ?? '').trim()
    const recent = this.getRecentSpokenText()
    if (msg.event === 'EndOfTurn') return this.final(text, msg.words ?? [], recent)
    if (!text || isEcho(text, recent)) return
    // Same order as voice.ts: the words make the hold the caller's, the fallback
    // start comes before the interim, and the interim goes out every time.
    this.barge.words()
    if (!this.talking && countWords(text) >= MIN_INTERIM_WORDS) {
      this.talking = true
      this.onSpeechStart()
    }
    this.onInterim(text)
  }

  /** Float samples from the capture; public so the check can feed audio without WebAudio. */
  audio(samples: Float32Array) {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || this.userMuted) return
    this.framer.push(toInt16(this.resampler.push(samples)), (frame) => ws.send(frame))
  }

  private final(text: string, words: { confidence?: number }[], recent: string) {
    const conf = words.reduce((m, w) => Math.max(m, w.confidence ?? 0), 0)
    // A single low-confidence word is room noise the model guessed at; a final
    // that is part narration keeps its user half (echo.ts).
    const kept = !text || (countWords(text) <= 1 && !confident(conf)) ? '' : isEcho(text, recent) ? stripEcho(text, recent) : text
    if (!kept) return this.endTurn()
    this.talking = false
    this.barge.utteranceDone()
    this.onUtterance(kept)
  }

  /** The turn ended with nothing to say. Release whichever hold is out. */
  private endTurn() {
    const wasTalking = this.talking
    this.talking = false
    const wasHeld = this.barge.held
    this.barge.reset() // releases the gate's own hold through onRelease
    if (wasTalking && !wasHeld) this.onFalseStart() // a hold the word path took has no other releaser
  }

  private async openPipe() {
    const ctx = audioContext()
    await ctx.resume()
    const stream = await getMicStream()
    await loadTap(ctx)
    const src = ctx.createMediaStreamSource(stream)
    const tap = new AudioWorkletNode(ctx, 'pcm-tap')
    const sink = ctx.createGain()
    sink.gain.value = 0 // the tap only runs while connected to the output; this keeps it silent
    src.connect(tap).connect(sink).connect(ctx.destination)
    tap.port.onmessage = (e) => this.audio(e.data as Float32Array)
    this.resampler = new Resampler(ctx.sampleRate, SAMPLE_RATE)
    this.pipe = { src, tap, sink }
  }

  private closePipe() {
    if (!this.pipe) return
    this.pipe.tap.port.onmessage = null
    this.pipe.src.disconnect()
    this.pipe.tap.disconnect()
    this.pipe.sink.disconnect()
    this.pipe = null
  }

  private takeSpare(): ListenGrant | null {
    const s = this.spare
    this.spare = null
    return s && Date.now() - s.at < (s.grant.expiresIn * 1000) / 2 ? s.grant : null
  }

  private async connect() {
    const gen = ++this.gen
    let grant: ListenGrant | null
    try {
      grant = this.takeSpare() ?? (await this.grants())
    } catch (e) {
      return this.failed(gen, e)
    }
    if (gen !== this.gen || !this.running) return
    if (!grant) return this.failed(gen, new Error('speech input is no longer configured'))
    const ws = new WebSocket(grant.url, grant.protocols)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.framer.reset()
    ws.onmessage = (e) => {
      if (this.ws !== ws || typeof e.data !== 'string') return
      let msg: FluxMessage
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      if (msg.type === 'Connected') this.openedAt = Date.now()
      this.handle(msg)
    }
    ws.onclose = (e) => {
      if (this.ws !== ws) return // stop() or a newer connection already let go of it
      this.ws = null
      this.endTurn()
      if (this.openedAt && Date.now() - this.openedAt >= HEALTHY_MS) this.failures = 0
      this.openedAt = 0
      if (!this.running || this.userMuted) return // unmuting reconnects
      this.failed(gen, new Error(`stream closed (${e.code})`))
    }
  }

  private failed(gen: number, e: unknown) {
    if (gen !== this.gen || !this.running) return
    this.failures++
    console.warn('speech input stream dropped', e)
    if (this.failures >= MAX_FAILURES) {
      this.stop()
      this.onError('Voice recognition keeps failing. Tap the mic to try again.')
      return
    }
    this.retry = setTimeout(
      () => {
        this.retry = null
        void this.connect()
      },
      Math.min(RETRY_MS * 2 ** (this.failures - 1), MAX_BACKOFF_MS),
    )
  }

  private disconnect() {
    const ws = this.ws
    this.ws = null
    if (!ws) return
    // CloseStream has Flux finish the audio it holds; this listener is done with it either way.
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }))
    ws.close()
  }
}

/** /api/listen: a grant, or null when the server has no streaming vendor. */
async function fetchGrant(): Promise<ListenGrant | null> {
  const res = await apiFetch('/api/listen', { method: 'POST' })
  if (res.status === 501) return null
  if (!res.ok) throw new Error(`speech input grant failed (${res.status})`)
  return (await res.json()) as ListenGrant
}
