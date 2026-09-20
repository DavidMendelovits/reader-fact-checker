// The playback queue: per-paragraph synthesis with prefetch, streamed replies,
// and the echo bookkeeping the ear needs. Where the audio comes from is an
// AudioSource (ports.ts); the default is the server's /api/tts, which hides the
// vendor. Position unit = flat paragraph index (see store).
// extension-explicit so this file can run under node --experimental-strip-types
import { apiFetch } from './api.ts'
import { attachOutput } from './audio-levels.ts'
import type { AudioSource } from './ports.ts'
// the hold policy is shared with the phone player; its checks live next to it
import { HoldGate } from '../../shared/voice/holdGate.ts'

/** The server's /api/tts route. Whatever vendor is configured there. */
export const serverSpeech: AudioSource = {
  synthesize: (text, signal) =>
    apiFetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    }),
}

const blobCache = new Map<string, Promise<string>>() // cacheKey -> object URL

// How long text stays echo-matchable after it finishes playing. Recognition
// finalizes an utterance seconds after the audio it heard has stopped, so the
// comparison text has to outlive the audio or the tail of every reply comes back
// as a user turn.
const ECHO_MEMORY = 6000

// Chrome streams MP3 into MediaSource fine; anything else falls back to buffering.
const CAN_STREAM =
  typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg')

async function synthesize(source: AudioSource, text: string): Promise<string> {
  const res = await source.synthesize(text)
  if (!res.ok) throw new Error(`TTS failed (${res.status}): ${await res.text()}`)
  return URL.createObjectURL(await res.blob())
}

function getAudioUrl(source: AudioSource, key: string, text: string): Promise<string> {
  let p = blobCache.get(key)
  if (!p) {
    p = synthesize(source, text)
    p.catch(() => blobCache.delete(key)) // allow retry after failure
    blobCache.set(key, p)
  }
  return p
}

/**
 * Point `audio` at a MediaSource fed by the response stream, so playback starts on
 * the first chunk instead of waiting for the whole clip. Resolves once the element
 * is wired up — not when playback ends.
 *
 * Synthesis runs far ahead of playback (~5s to generate ~30s of speech), so
 * underruns aren't a practical concern.
 */
async function attachStream(
  source: AudioSource,
  audio: HTMLAudioElement,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const res = await source.synthesize(text, signal)
  if (!res.ok) throw new Error(`TTS failed (${res.status}): ${await res.text()}`)
  const body = res.body
  if (!body) throw new Error('TTS returned no body')

  const media = new MediaSource()
  audio.src = URL.createObjectURL(media)
  await new Promise<void>((resolve) =>
    media.addEventListener('sourceopen', () => resolve(), { once: true }),
  )

  const buffer = media.addSourceBuffer('audio/mpeg')
  const queue: Uint8Array[] = []
  let finished = false
  const pump = () => {
    if (buffer.updating) return
    const next = queue.shift()
    if (next) buffer.appendBuffer(next as BufferSource)
    else if (finished && media.readyState === 'open') media.endOfStream()
  }
  buffer.addEventListener('updateend', pump)

  // drain in the background; playback proceeds as chunks land
  void (async () => {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        queue.push(value)
        pump()
      }
    } catch {
      /* aborted or network error — endOfStream below leaves what we have playable */
    } finally {
      finished = true
      pump()
    }
  })()
}

export class TtsPlayer {
  private source: AudioSource

  // a plain field, not a constructor parameter property: this file is loaded by
  // its own check under node's strip-only TypeScript
  constructor(source: AudioSource) {
    this.source = source
  }

  private audio = new Audio()
  private session = 0 // bumped to cancel in-flight playback loops
  onParagraphChange: (index: number) => void = () => {}
  onEnded: () => void = () => {}
  /**
   * Fires whenever *document narration* starts or stops, from any caller — manual
   * Play, the agent's read_aloud, a fast-path resume, or a pause that cut any of
   * them short. The header's Play/Pause button reads this, so the player has to own
   * it: every place that used to flip `playing` by hand eventually drifted.
   */
  onPlayingChange: (playing: boolean) => void = () => {}

  private paragraphs: string[] = []
  private index = 0
  rate = 1
  /** Text currently coming out of the speaker — the echo filter matches against it. */
  speaking = ''
  private recent: { text: string; until: number }[] = []

  /** What's playing now plus what played in the last few seconds. */
  get recentlySpoken(): string {
    const now = Date.now()
    this.recent = this.recent.filter((r) => r.until > now)
    return [...this.recent.map((r) => r.text), this.speaking].join(' ')
  }

  /** Called as text stops playing; it stays matchable for a while after. */
  private remember(text: string) {
    if (text) this.recent.push({ text, until: Date.now() + ECHO_MEMORY })
  }
  private streamAbort: AbortController | null = null
  private narrating = false
  private gate = new HoldGate()
  // Resolves the paragraph currently awaited in playFrom. A paused <audio> never
  // fires 'ended', so without this an interruption left read_aloud hanging forever.
  private interrupt: (() => void) | null = null

  setParagraphs(paragraphs: string[]) {
    this.paragraphs = paragraphs
  }

  get currentIndex() {
    return this.index
  }

  /** Parked mid-range by hold(): silent, but the range is still live. */
  get held(): boolean {
    return this.gate.held
  }

  private setNarrating(on: boolean) {
    if (this.narrating === on) return
    this.narrating = on
    this.onPlayingChange(on)
  }

  /**
   * Read paragraphs [index, until] aloud. Resolves 'completed' when the range
   * finishes, 'stopped' if pause() cancelled it (the agent's read_aloud tool
   * distinguishes the outcomes — 'stopped' means the user talked over it), or
   * 'failed' when synthesis itself is down — see runRange.
   */
  async playFrom(index: number, until = Infinity): Promise<'completed' | 'stopped' | 'failed'> {
    const session = ++this.session
    const last = Math.min(until, this.paragraphs.length - 1)
    this.index = index
    this.setNarrating(true)
    try {
      return await this.runRange(index, last, session)
    } finally {
      // only clear if we're still the live session — a barge-in that immediately
      // started a new range must not be flipped back off by the old one unwinding
      if (session === this.session) this.setNarrating(false)
    }
  }

  private async runRange(index: number, last: number, session: number): Promise<'completed' | 'stopped' | 'failed'> {
    this.index = index
    // One bad paragraph is worth skipping; a run of them means the TTS endpoint
    // is down, and "skip" then races through the whole book at network speed —
    // the position ends up at the last paragraph with nothing read. Stop instead,
    // holding the position at the first paragraph of the failing stretch.
    let failStreak = 0
    while (this.index <= last && session === this.session) {
      const i = this.index
      // The one park site (see hold(), and the diagram in shared/voice/holdGate.ts).
      // `this.index` never moved, so a release replays this paragraph from its
      // start — out of the blob cache when it was prefetched, streamed again if not.
      if (this.gate.held) {
        const resume = await this.gate.wait()
        if (session !== this.session || resume === 'abandon') return 'stopped'
      }
      this.onParagraphChange(i)
      // Prefetch two ahead. One was enough when every paragraph cost a full
      // synthesis wait; now that the current one streams, a deeper queue is what
      // keeps the *gaps* between paragraphs at zero.
      for (const n of [i + 1, i + 2]) {
        if (n <= last) void getAudioUrl(this.source, `p${n}`, this.paragraphs[n]).catch(() => {})
      }
      try {
        this.speaking = this.paragraphs[i]
        await this.playParagraph(i, session)
        if (session !== this.session) return 'stopped'
        failStreak = 0
      } catch (e) {
        // pause() aborts the in-flight stream; that rejection is the user, not an outage
        if (session !== this.session) return 'stopped'
        // so is hold()'s abort — counting it as an outage would skip the paragraph
        // the hold is parked on.
        if (!this.gate.held) {
          console.error('TTS error, skipping paragraph', i, e)
          if (++failStreak >= 3) {
            this.index = i - failStreak + 1
            return 'failed'
          }
        }
      } finally {
        this.remember(this.speaking)
        this.speaking = ''
      }
      if (session !== this.session) return 'stopped'
      if (this.gate.held) continue // park at the top; the index stays on this paragraph
      this.index = i + 1
    }
    if (session !== this.session) return 'stopped'
    this.onEnded()
    return 'completed'
  }

  /**
   * Prefetched paragraphs play instantly from cache; an uncached one (the first
   * after Play, or after an interruption) streams so audio starts on the first
   * chunk rather than after the whole clip synthesizes.
   */
  private async playParagraph(i: number, session: number): Promise<void> {
    const key = `p${i}`
    const text = this.paragraphs[i]
    if (blobCache.has(key) || !CAN_STREAM) {
      const url = await getAudioUrl(this.source, key, text)
      if (session !== this.session) return
      return this.playUrl(url, session)
    }
    return this.playStreamed(text, session)
  }

  private playStreamed(text: string, session: number): Promise<void> {
    void attachOutput(this.audio)
    // Interrupting mid-paragraph must kill the download too, or every barge-in
    // leaves a stream draining in the background and burns TTS credits.
    this.streamAbort?.abort()
    const abort = new AbortController()
    this.streamAbort = abort
    return new Promise((resolve, reject) => {
      this.interrupt = resolve
      attachStream(this.source, this.audio, text, abort.signal).then(
        () => {
          if (session !== this.session) {
            this.audio.pause()
            return resolve()
          }
          this.audio.playbackRate = this.rate
          this.audio.onended = () => resolve()
          this.audio.onerror = () => resolve()
          this.audio.play().catch(() => resolve())
        },
        // Rejecting (not resolving) is what lets runRange count an outage —
        // swallowing this here made a dead TTS endpoint indistinguishable from
        // a paragraph that played fine.
        reject,
      )
    })
  }

  private playUrl(url: string, session: number): Promise<void> {
    void attachOutput(this.audio) // idempotent; no-op if WebAudio isn't usable
    return new Promise((resolve) => {
      this.interrupt = resolve
      this.audio.src = url
      this.audio.playbackRate = this.rate
      this.audio.onended = () => resolve()
      this.audio.onerror = () => resolve()
      this.audio.play().catch(() => resolve())
      // safety: if session was cancelled while awaiting play
      if (session !== this.session) {
        this.audio.pause()
        resolve()
      }
    })
  }

  /**
   * Duck the narration without ending the range: the session is untouched, so the
   * agent's read_aloud is still waiting and release() replays the paragraph from
   * its start. pause() is the same stop with the range given up.
   */
  hold() {
    if (this.gate.held) return
    this.gate.hold()
    this.stopAudio()
    // `playing` deliberately stays true: the range is still live, the row tint has
    // not moved, and a cough must cost nothing. `held` is the separate signal.
  }

  /** Resume the paragraph the hold parked on. No-op if pause() got there first. */
  release() {
    this.gate.release()
  }

  private stopAudio() {
    this.streamAbort?.abort()
    this.streamAbort = null
    this.audio.pause()
    // a paused <audio> never fires 'ended'; without this the paragraph's promise
    // would never settle and the loop would never reach its park
    this.interrupt?.()
    this.interrupt = null
  }

  pause() {
    this.session++ // cancels the loop
    this.gate.abandon() // a parked loop unwinds as 'stopped'
    this.stopAudio()
    this.setNarrating(false)
  }

  setRate(rate: number) {
    this.rate = rate
    this.audio.playbackRate = rate
  }

  clearCacheForNewDoc() {
    blobCache.clear()
  }

  /** Speak arbitrary text (fact-check verdicts) outside the paragraph loop. */
  speak(text: string): Promise<void> {
    const s = this.speakStream()
    s.push(text)
    return s.end()
  }

  /**
   * Speak text that arrives a sentence at a time — the agent's reply, which the
   * model is still writing while the first sentence plays. The first sentence
   * streams (audio on the first byte); later ones are synthesized the moment they
   * are pushed and play from cache, so the gap between sentences stays at zero.
   *
   * pause() cuts it off like any other playback: whatever is queued is dropped and
   * end() resolves as soon as the current clip stops.
   */
  speakStream(): SpeechStream {
    this.pause()
    void attachOutput(this.audio)
    const session = this.session
    const queue: string[] = []
    let pushed = 0
    let ended = false
    let wake: (() => void) | null = null
    const signal = () => {
      wake?.()
      wake = null
    }

    const drain = async () => {
      let first = true
      for (;;) {
        if (session !== this.session) return
        const text = queue.shift()
        if (text === undefined) {
          if (ended) return
          await new Promise<void>((r) => (wake = r))
          continue
        }
        try {
          this.speaking = text
          if (first) await this.playStreamed(text, session)
          else {
            const url = await getAudioUrl(this.source, `s:${text}`, text)
            if (session !== this.session) return
            await this.playUrl(url, session)
          }
        } catch (e) {
          console.error('TTS error, skipping sentence', e)
        } finally {
          this.remember(this.speaking)
          this.speaking = ''
        }
        first = false
      }
    }
    const done = drain()

    return {
      push: (text) => {
        const t = text.trim()
        if (!t || ended) return
        queue.push(t)
        // synthesize ahead of playback; the first sentence streams instead
        if (pushed++ > 0) void getAudioUrl(this.source, `s:${t}`, t).catch(() => {})
        signal()
      },
      end: () => {
        ended = true
        signal()
        return done
      },
    }
  }
}

export interface SpeechStream {
  /** Queue a complete sentence. Ignored after end(). */
  push(text: string): void
  /** No more sentences; resolves once everything queued has played, or playback was cut off. */
  end(): Promise<void>
}

